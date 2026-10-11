// Live HSE Quiz — Cloudflare Worker + Durable Object
// One Durable Object instance = one live quiz room (identified by a 6-character code).
// All quiz state (players, questions, scores, timer) lives server-side so phones and the
// presenter screen always agree, and correct answers never reach participants early.

import BANK from "./questions.json";

// ---- Quiz settings (change here if needed) ----
const SETTINGS = {
  numQuestions: 20,        // questions per live quiz, drawn at random from the bank
  secondsPerQuestion: 40,  // answer window per question
  maxPoints: 1000,         // a correct answer given instantly
  minPoints: 500,          // a correct answer given in the last second
  graceMs: 600,            // network grace after the deadline
  revealBeforeFinalMs: 6000, // how long the last answer is shown before the winners appear
  maxPlayers: 300,
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no O/0/I/1

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function randomCode(n = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

function randomToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Pick N questions: first spread across as many different procedures as possible,
// then fill any remainder at random. Options are shuffled for every quiz run.
function drawQuestions(n) {
  const byRef = {};
  for (const q of BANK) (byRef[q.ref] ||= []).push(q);
  // One random question from each procedure (in random order) ...
  const firstPass = shuffle(Object.keys(byRef)).map((r) => shuffle(byRef[r])[0]);
  let picked = firstPass.slice(0, n);
  // ... then, if more are needed than there are procedures, fill from the rest.
  if (picked.length < n) {
    const ids = new Set(picked.map((q) => q.id));
    picked = picked.concat(shuffle(BANK.filter((q) => !ids.has(q.id))).slice(0, n - picked.length));
  }
  return shuffle(picked).map((q) => {
    const order = shuffle([0, 1, 2, 3]);
    return {
      id: q.id,
      ref: q.ref,
      topic: q.topic,
      q: q.q,
      options: order.map((i) => q.options[i]),
      answer: order.indexOf(q.answer),
      source: q.source,
    };
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = randomCode();
        const stub = env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName(code));
        const res = await stub.fetch("https://room/init", {
          method: "POST",
          body: JSON.stringify({ code }),
        });
        if (res.ok) return json(await res.json());
      }
      return json({ error: "Could not create a room, please retry." }, 500);
    }

    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{6})$/);
    if (m) {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const stub = env.QUIZ_ROOM.get(env.QUIZ_ROOM.idFromName(m[1]));
      return stub.fetch(request);
    }

    const j = url.pathname.match(/^\/j\/([A-Za-z0-9]{6})$/);
    if (j) return Response.redirect(`${url.origin}/play.html?room=${j[1].toUpperCase()}`, 302);

    if (url.pathname === "/api/health") return json({ ok: true, questionsInBank: BANK.length });

    return env.ASSETS.fetch(request);
  },
};

export class QuizRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.s = null;
    ctx.blockConcurrencyWhile(async () => {
      this.s = (await ctx.storage.get("s")) || null;
    });
  }

  async save() {
    await this.ctx.storage.put("s", this.s);
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/init") {
      if (this.s) return new Response("exists", { status: 409 });
      const { code } = await request.json();
      this.s = {
        code,
        hostKey: randomToken(),
        createdAt: Date.now(),
        phase: "lobby",
        questions: [],
        qIndex: -1,
        qStart: 0,
        qDeadline: 0,
        revealAt: 0,
        players: {},
        round: 0,
      };
      await this.save();
      return json({ code, hostKey: this.s.hostKey });
    }

    if (request.headers.get("Upgrade") === "websocket") {
      if (!this.s) return new Response("Room not found", { status: 404 });
      const role = url.searchParams.get("role") === "host" ? "host" : "player";
      if (role === "host" && url.searchParams.get("key") !== this.s.hostKey) {
        return new Response("Forbidden", { status: 403 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role, pid: null });
      if (role === "host") this.sendTo(server);
      else server.send(JSON.stringify({ t: "hello", room: this.s.code, phase: this.s.phase, now: Date.now() }));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  // ---------- WebSocket events (hibernation API) ----------
  async webSocketMessage(ws, raw) {
    if (!this.s) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const att = ws.deserializeAttachment() || {};

    if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong", now: Date.now() })); return; }

    if (att.role === "host") return this.handleHost(ws, msg);
    return this.handlePlayer(ws, att, msg);
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch {}
    this.broadcast();
  }
  async webSocketError(ws) { this.broadcast(); }

  // ---------- Host actions ----------
  async handleHost(ws, msg) {
    const s = this.s;
    switch (msg.t) {
      case "start":
        if (s.phase !== "lobby") break;
        if (!Object.keys(s.players).length) { ws.send(JSON.stringify({ t: "error", message: "Wait for at least one participant to join." })); break; }
        s.questions = drawQuestions(SETTINGS.numQuestions);
        s.round += 1;
        await this.openQuestion(0);
        return;
      case "next":
        if (s.phase !== "reveal") break;
        if (s.qIndex + 1 >= s.questions.length) { await this.finish(); return; }
        await this.openQuestion(s.qIndex + 1);
        return;
      case "end_question":
        if (s.phase === "question") { await this.closeQuestion(); return; }
        break;
      case "finish":
        if (s.phase === "reveal" || s.phase === "question") { await this.finish(); return; }
        break;
      case "restart":
        // New random set of questions, same participants, scores reset.
        for (const p of Object.values(s.players)) { p.score = 0; p.correct = 0; p.timeMs = 0; p.answers = {}; }
        s.phase = "lobby"; s.qIndex = -1; s.questions = []; s.qStart = 0; s.qDeadline = 0; s.revealAt = 0;
        await this.ctx.storage.deleteAlarm();
        await this.save();
        this.broadcast();
        return;
      case "kick":
        if (s.players[msg.pid]) {
          delete s.players[msg.pid];
          for (const w of this.ctx.getWebSockets()) {
            const a = w.deserializeAttachment() || {};
            if (a.pid === msg.pid) { try { w.send(JSON.stringify({ t: "kicked" })); w.close(4000, "removed"); } catch {} }
          }
          await this.save();
          this.broadcast();
        }
        return;
    }
    this.sendTo(ws);
  }

  // ---------- Player actions ----------
  async handlePlayer(ws, att, msg) {
    const s = this.s;
    if (msg.t === "join") {
      let pid = typeof msg.pid === "string" && s.players[msg.pid] ? msg.pid : null;
      if (!pid) {
        let name = String(msg.name || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
        if (name.length < 2) { ws.send(JSON.stringify({ t: "error", message: "Please enter your name (at least 2 characters)." })); return; }
        if (Object.keys(s.players).length >= SETTINGS.maxPlayers) { ws.send(JSON.stringify({ t: "error", message: "This quiz is full." })); return; }
        const taken = new Set(Object.values(s.players).map((p) => p.name.toLowerCase()));
        let finalName = name, n = 2;
        while (taken.has(finalName.toLowerCase())) finalName = `${name} (${n++})`;
        pid = randomToken().slice(0, 16);
        s.players[pid] = { name: finalName, score: 0, correct: 0, timeMs: 0, answers: {}, joinedAt: Date.now() };
        await this.save();
      }
      ws.serializeAttachment({ role: "player", pid });
      ws.send(JSON.stringify({ t: "joined", pid, name: s.players[pid].name }));
      this.broadcast();
      return;
    }

    if (msg.t === "answer") {
      const pid = att.pid;
      const p = pid && s.players[pid];
      if (!p || s.phase !== "question" || msg.qIndex !== s.qIndex) return;
      if (p.answers[s.qIndex]) return; // answer is locked once given
      const choice = Number(msg.choice);
      if (!(choice >= 0 && choice <= 3)) return;
      const now = Date.now();
      if (now < s.qStart - 250) return; // the timer has not started yet
      if (now > s.qDeadline + SETTINGS.graceMs) return;
      const elapsed = Math.max(0, Math.min(now, s.qDeadline) - s.qStart);
      const total = s.qDeadline - s.qStart;
      const q = s.questions[s.qIndex];
      const correct = choice === q.answer;
      const points = correct
        ? Math.round(SETTINGS.minPoints + (SETTINGS.maxPoints - SETTINGS.minPoints) * (1 - elapsed / total))
        : 0;
      p.answers[s.qIndex] = { choice, correct, points, ms: elapsed };
      p.score += points;
      if (correct) { p.correct += 1; p.timeMs += elapsed; }
      await this.save();

      // Close early once every connected participant has answered.
      const connected = this.connectedPids();
      const allIn = connected.size > 0 && [...connected].every((id) => s.players[id] && s.players[id].answers[s.qIndex]);
      if (allIn) { await this.closeQuestion(); return; }
      this.broadcast();
      return;
    }
  }

  // ---------- Quiz flow ----------
  async openQuestion(i) {
    const s = this.s;
    s.phase = "question";
    s.qIndex = i;
    s.qStart = Date.now() + 1500; // short "get ready" lead-in
    s.qDeadline = s.qStart + SETTINGS.secondsPerQuestion * 1000;
    await this.ctx.storage.setAlarm(s.qDeadline + SETTINGS.graceMs);
    await this.save();
    this.broadcast();
  }

  async closeQuestion() {
    const s = this.s;
    if (s.phase !== "question") return;
    s.phase = "reveal";
    s.revealAt = Date.now();
    const last = s.qIndex + 1 >= s.questions.length;
    if (last) await this.ctx.storage.setAlarm(Date.now() + SETTINGS.revealBeforeFinalMs);
    else await this.ctx.storage.deleteAlarm();
    await this.save();
    this.broadcast();
  }

  async finish() {
    this.s.phase = "final";
    await this.ctx.storage.deleteAlarm();
    await this.save();
    this.broadcast();
  }

  async alarm() {
    if (!this.s) return;
    if (this.s.phase === "question") return this.closeQuestion();
    if (this.s.phase === "reveal" && this.s.qIndex + 1 >= this.s.questions.length) return this.finish();
  }

  // ---------- Views ----------
  connectedPids() {
    const set = new Set();
    for (const w of this.ctx.getWebSockets()) {
      const a = w.deserializeAttachment() || {};
      if (a.role === "player" && a.pid) set.add(a.pid);
    }
    return set;
  }

  ranking() {
    if (this._rk) return this._rk;
    const connected = this.connectedPids();
    return Object.entries(this.s.players)
      .map(([pid, p]) => ({ pid, name: p.name, score: p.score, correct: p.correct, timeMs: p.timeMs, online: connected.has(pid) }))
      .sort((a, b) => b.score - a.score || b.correct - a.correct || a.timeMs - b.timeMs || a.name.localeCompare(b.name))
      .map((r, i) => ({ ...r, rank: i + 1 }));
  }

  computeRanking() { this._rk = null; const r = this.ranking(); this._rk = r; return r; }

  hostView() {
    const s = this.s;
    const ranking = this.ranking();
    const q = s.questions[s.qIndex];
    const showAnswer = s.phase === "reveal" || s.phase === "final";
    const view = {
      t: "state",
      role: "host",
      now: Date.now(),
      room: s.code,
      phase: s.phase,
      settings: { numQuestions: SETTINGS.numQuestions, secondsPerQuestion: SETTINGS.secondsPerQuestion },
      qIndex: s.qIndex,
      total: s.questions.length || SETTINGS.numQuestions,
      qStart: s.qStart,
      qDeadline: s.qDeadline,
      players: ranking,
      answeredPids: q ? Object.entries(s.players).filter(([, p]) => p.answers[s.qIndex]).map(([pid]) => pid) : [],
      lastPoints: q ? Object.fromEntries(Object.entries(s.players).filter(([, p]) => p.answers[s.qIndex]).map(([pid, p]) => [pid, p.answers[s.qIndex].points])) : {},
      bankSize: BANK.length,
    };
    if (q && s.phase !== "lobby") {
      view.question = { ref: q.ref, topic: q.topic, q: q.q, options: q.options };
      if (showAnswer) {
        view.question.answer = q.answer;
        view.question.source = q.source;
        const counts = [0, 0, 0, 0];
        for (const p of Object.values(s.players)) { const a = p.answers[s.qIndex]; if (a) counts[a.choice]++; }
        view.question.counts = counts;
      }
    }
    if (s.phase === "final") {
      view.summary = s.questions.map((qq, i) => {
        const n = Object.values(s.players).filter((p) => p.answers[i]?.correct).length;
        return { i, ref: qq.ref, correctCount: n };
      });
    }
    return view;
  }

  playerView(pid) {
    const s = this.s;
    const p = s.players[pid];
    const ranking = this.ranking();
    const me = ranking.find((r) => r.pid === pid);
    const q = s.questions[s.qIndex];
    const view = {
      t: "state",
      role: "player",
      now: Date.now(),
      room: s.code,
      phase: s.phase,
      qIndex: s.qIndex,
      total: s.questions.length || SETTINGS.numQuestions,
      qStart: s.qStart,
      qDeadline: s.qDeadline,
      me: p ? { name: p.name, score: p.score, rank: me?.rank, of: ranking.length } : null,
      playerCount: ranking.length,
    };
    if (q && (s.phase === "question" || s.phase === "reveal")) {
      view.question = { ref: q.ref, q: q.q, options: q.options };
      const mine = p?.answers[s.qIndex];
      view.myAnswer = mine ? { choice: mine.choice } : null;
      if (s.phase === "reveal") {
        view.question.answer = q.answer;
        view.myAnswer = mine ? { choice: mine.choice, correct: mine.correct, points: mine.points } : null;
      }
    }
    if (s.phase === "final") view.podium = ranking.slice(0, 3).map((r) => ({ name: r.name, score: r.score, rank: r.rank }));
    return view;
  }

  sendTo(ws, keepCache) {
    if (!keepCache) this._rk = null;
    const a = ws.deserializeAttachment() || {};
    try {
      if (a.role === "host") ws.send(JSON.stringify(this.hostView()));
      else if (a.pid) ws.send(JSON.stringify(this.playerView(a.pid)));
    } catch {}
  }

  broadcast() {
    if (!this.s) return;
    this.computeRanking();
    for (const w of this.ctx.getWebSockets()) this.sendTo(w, true);
    this._rk = null;
  }
}
