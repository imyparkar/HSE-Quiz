// Presenter screen logic
let sock = null;
let state = null;
let tickTimer = null;
let lastNames = "";
let catalog = null;          // [{ ref, name, easy, medium }] from /api/catalog
let maxQ = 20;               // questions per quiz (server setting)
const selected = new Set();  // procedure refs ticked on the setup screen
let level = "default";       // easy | medium | default

// ---------- Setup screen: topics + difficulty ----------
function countFor(p, lvl) { return lvl === "easy" ? p.easy : lvl === "medium" ? p.medium : p.easy + p.medium; }

function renderTopics() {
  if (!catalog) return;
  $("topics").innerHTML = catalog.map((p) => {
    const n = countFor(p, level);
    const on = selected.has(p.ref);
    return `<label class="topic ${on ? "on" : ""} ${n ? "" : "none"}">
      <input type="checkbox" value="${p.ref}" ${on ? "checked" : ""}>
      <span class="tick" aria-hidden="true"></span>
      <span class="tname"><small>${esc(p.ref)}</small>${esc(p.name)}</span>
      <span class="tcount" title="${n} question${n === 1 ? "" : "s"} at this level">${n}</span>
    </label>`;
  }).join("");
  updateSummary();
}

function updateSummary() {
  if (!catalog) return;
  const chosen = catalog.filter((p) => selected.has(p.ref));
  $("selCount").textContent = chosen.length;
  for (const [lvl, id] of [["easy", "cntEasy"], ["medium", "cntMedium"], ["default", "cntDefault"]]) {
    $(id).textContent = chosen.reduce((t, p) => t + countFor(p, lvl), 0);
  }
  const pool = chosen.reduce((t, p) => t + countFor(p, level), 0);
  const withQs = chosen.filter((p) => countFor(p, level) > 0).length;
  const n = Math.min(maxQ, pool);
  const lvlName = { easy: "Easy", medium: "Medium", default: "Default (mixed)" }[level];
  const warn = $("poolWarn");
  if (!chosen.length) {
    $("poolLine").innerHTML = "Select at least one topic.";
    warn.classList.add("hidden");
  } else if (!pool) {
    $("poolLine").innerHTML = `No <b>${lvlName}</b> questions in the selected topic${chosen.length === 1 ? "" : "s"}.`;
    warn.classList.add("hidden");
  } else {
    $("poolLine").innerHTML = `<b>${pool}</b> matching question${pool === 1 ? "" : "s"} · <b>${lvlName}</b><br>Quiz will have <b class="big">${n}</b> question${n === 1 ? "" : "s"} from ${Math.min(withQs, n)} topic${Math.min(withQs, n) === 1 ? "" : "s"}`;
    warn.textContent = pool < maxQ ? `Fewer than ${maxQ} questions match, so this quiz will be shorter. Add topics or choose Default for a full ${maxQ}-question quiz.` : "";
    warn.classList.toggle("hidden", pool >= maxQ);
  }
  $("createBtn").disabled = !pool;
  store("local", "hseq_setup", JSON.stringify({ refs: [...selected], level }));
}

async function loadCatalog() {
  try {
    const r = await fetch("/api/catalog");
    const d = await r.json();
    catalog = d.procedures;
    maxQ = d.numQuestions || 20;
    $("bankSize").textContent = d.total;
    $("factQ").textContent = maxQ;
    let prev = null;
    try { prev = JSON.parse(store("local", "hseq_setup") || "null"); } catch {}
    const known = new Set(catalog.map((p) => p.ref));
    const refs = prev && Array.isArray(prev.refs) ? prev.refs.filter((x) => known.has(x)) : [];
    (refs.length ? refs : [...known]).forEach((x) => selected.add(x));
    if (prev && ["easy", "medium", "default"].includes(prev.level)) level = prev.level;
    document.querySelector(`input[name=lvl][value=${level}]`).checked = true;
    renderTopics();
  } catch {
    $("topics").innerHTML = `<div class="muted">Could not load the procedure list. Check the connection and refresh the page.</div>`;
  }
}

const saved = () => {
  const code = store("local", "hseq_host_code");
  const key = store("local", "hseq_host_key");
  return code && key ? { code, key } : null;
};

function joinLink(code) { return `${location.origin}/play.html?room=${code}`; }

function renderQR(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  $("qr").innerHTML = qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true });
}

async function createRoom() {
  $("createBtn").disabled = true;
  try {
    const r = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refs: [...selected], difficulty: level }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed");
    store("local", "hseq_host_code", d.code);
    store("local", "hseq_host_key", d.hostKey);
    connect(d.code, d.hostKey);
  } catch (e) {
    toast("Could not create a session: " + e.message);
  } finally {
    updateSummary();
  }
}

function connect(code, key) {
  if (sock) sock.close();
  $("roomCode").textContent = code;
  $("roomChip").classList.remove("hidden");
  $("bigCode").textContent = code;
  $("joinUrl").textContent = joinLink(code);
  renderQR(joinLink(code));
  let failures = 0;
  sock = liveSocket(`/ws/${code}?role=host&key=${encodeURIComponent(key)}`, {
    onMessage: (m) => {
      failures = 0;
      if (m.t === "state") { state = m; render(); }
      if (m.t === "error") toast(m.message);
    },
    onStatus: (on) => {
      $("conn").classList.toggle("off", !on);
      $("connText").textContent = on ? "Live" : "Reconnecting…";
      if (!on && ++failures > 4 && !state) {
        sock.close();
        store("local", "hseq_host_code", null);
        store("local", "hseq_host_key", null);
        toast("That session is no longer available. Create a new one.");
        show("s-start");
      }
    },
  });
}

function render() {
  const s = state;
  if (s.phase === "lobby") return renderLobby();
  if (s.phase === "question" || s.phase === "reveal") return renderQuestion();
  if (s.phase === "final") return renderFinal();
}

function renderLobby() {
  show("s-lobby");
  stopTick();
  const ps = state.players;
  $("pCount").textContent = ps.length;
  $("pPlural").textContent = ps.length === 1 ? "" : "s";
  $("noNames").classList.toggle("hidden", ps.length > 0);
  $("presentBtn").disabled = ps.length === 0;
  const c = state.config;
  if (c) {
    const topics = c.allTopics ? "All 24 topics" : c.topics.length <= 4 ? c.topics.map((t) => esc(t.ref)).join(", ") : `${c.topics.length} topics`;
    const title = c.topics.map((t) => `${t.ref} ${t.name}`).join("\n");
    $("cfgLine").innerHTML = `<span class="chip" title="${esc(title)}">Topics <b>${topics}</b></span><span class="chip">Level <b>${esc(c.difficultyLabel)}</b></span><span class="chip"><b>${c.numQuestions}</b> questions</span>`;
  }
  const sig = ps.map((p) => p.pid + p.online).join("|");
  if (sig !== lastNames) {
    lastNames = sig;
    $("names").innerHTML = ps
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => `<span class="name-tag ${p.online ? "" : "off"}">${esc(p.name)}<button title="Remove" data-kick="${p.pid}">✕</button></span>`)
      .join("");
  }
}

function renderQuestion() {
  show("s-question");
  const s = state, q = s.question;
  const reveal = s.phase === "reveal";
  $("qNum").textContent = s.qIndex + 1;
  $("qTotal").textContent = s.total;
  $("qRef").textContent = q.ref;
  $("qRef").title = q.procedure || "";
  $("qDiff").textContent = q.difficulty || "";
  $("qDiff").classList.toggle("hidden", !q.difficulty);
  $("qText").textContent = q.q;
  $("dots").innerHTML = Array.from({ length: s.total }, (_, i) => `<i class="${i < s.qIndex ? "done" : i === s.qIndex ? "now" : ""}"></i>`).join("");

  const online = s.players.filter((p) => p.online).length;
  $("answered").textContent = s.answeredPids.length;
  $("answerable").textContent = Math.max(online, s.answeredPids.length);

  const optsEl = $("opts");
  optsEl.classList.toggle("reveal", reveal);
  optsEl.innerHTML = q.options.map((o, i) => {
    const cls = reveal ? (i === q.answer ? "right" : "wrong") : "";
    const count = reveal && q.counts ? `<span class="count">${q.counts[i]}</span>` : "";
    const tick = reveal && i === q.answer ? `<span class="tick">✓</span>` : "";
    return `<div class="opt ${cls}" data-i="${i}"><span class="shape">${SHAPES[i]}<small>${LETTERS[i]}</small></span><span>${esc(o)}</span>${count}${tick}</div>`;
  }).join("");

  $("qSource").classList.toggle("hidden", !reveal);
  if (reveal) $("qSource").innerHTML = `<b>${esc(q.ref)}${q.procedure ? " " + esc(q.procedure) : ""}</b> — ${esc(q.source)}`;

  const last = s.qIndex + 1 >= s.total;
  $("nextBtn").classList.toggle("hidden", !reveal || last);
  $("finishBtn").classList.toggle("hidden", !(reveal && last));
  $("endBtn").classList.toggle("hidden", reveal);
  $("boardSub").textContent = reveal ? (last ? "Final question — winners coming up…" : "Standings after this question") : "Scores update as answers arrive";

  renderBoard($("board"), s.players.slice(0, 12), true);
  if (reveal) { stopTick(); setTimer(0, s.settings.secondsPerQuestion, true); }
  else startTick();
}

function renderBoard(el, rows, showDelta) {
  const answered = new Set(state.answeredPids || []);
  el.innerHTML = rows.length ? rows.map((p) => {
    const d = state.lastPoints ? state.lastPoints[p.pid] : undefined;
    const delta = showDelta && d !== undefined ? `<span class="delta ${d ? "" : "zero"}">+${d}</span>` : "";
    return `<div class="row ${answered.has(p.pid) && state.phase === "question" ? "answered" : ""}"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)}</span><span class="sc">${p.score.toLocaleString()}${delta}</span></div>`;
  }).join("") : `<div class="muted">No participants yet</div>`;
}

function setTimer(remainingMs, totalS, done) {
  const total = totalS * 1000;
  const frac = Math.max(0, Math.min(1, remainingMs / total));
  const secs = Math.ceil(remainingMs / 1000);
  $("timerArc").setAttribute("stroke-dashoffset", String(289 * (1 - frac)));
  $("timerNum").textContent = done ? "0" : Math.max(0, Math.min(totalS, secs));
  $("timer").classList.toggle("low", secs <= 10);
  $("timerArc").setAttribute("stroke", secs <= 10 ? "#e0453a" : "#0071e3");
}

function startTick() {
  stopTick();
  const step = () => {
    if (!state || state.phase !== "question") return;
    const now = serverNow();
    if (now < state.qStart) { setTimer(state.qDeadline - state.qStart, state.settings.secondsPerQuestion); $("timerNum").textContent = "Go"; return; }
    setTimer(state.qDeadline - now, state.settings.secondsPerQuestion);
  };
  step();
  tickTimer = setInterval(step, 200);
}
function stopTick() { clearInterval(tickTimer); tickTimer = null; }

function renderFinal() {
  show("s-final");
  stopTick();
  const ps = state.players;
  const top = ps.slice(0, 3);
  const order = [1, 0, 2]; // 2nd, 1st, 3rd
  const medals = ["🥇", "🥈", "🥉"];
  $("podium").innerHTML = order.map((i) => {
    const p = top[i];
    if (!p) return `<div></div>`;
    return `<div class="step p${i + 1}"><div class="medal">${medals[i]}</div><div class="who">${esc(p.name)}</div><div class="pts">${p.score.toLocaleString()} pts · ${p.correct}/${state.total} correct</div><div class="place">${i + 1}</div></div>`;
  }).join("");
  const c = state.config;
  $("finalSub").textContent = `${ps.length} participant${ps.length === 1 ? "" : "s"} · ${state.total} questions` + (c ? ` · ${c.difficultyLabel} · ${c.allTopics ? "all topics" : c.topics.length + " topic" + (c.topics.length === 1 ? "" : "s")}` : "");
  $("finalBoard").innerHTML = ps.map((p) => `<div class="row"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)} <span class="muted" style="font-weight:400">· ${p.correct}/${state.total} correct</span></span><span class="sc">${p.score.toLocaleString()}</span></div>`).join("");
}

function downloadCSV() {
  if (!state) return;
  const rows = [["Rank", "Name", "Score", "Correct", "Questions", "Difficulty", "Topics", "Room", "Date"]];
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  const c = state.config;
  const lvl = c ? c.difficultyLabel : "";
  const topics = c ? (c.allTopics ? "All topics" : c.refs.join(" ")) : "";
  for (const p of state.players) rows.push([p.rank, p.name, p.score, p.correct, state.total, lvl, topics, state.room, date]);
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `HSE-Quiz-results-${state.room}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---- Wire up ----
$("createBtn").onclick = createRoom;
$("presentBtn").onclick = () => sock && sock.send({ t: "start" });
$("nextBtn").onclick = () => sock && sock.send({ t: "next" });
$("endBtn").onclick = () => sock && sock.send({ t: "end_question" });
$("finishBtn").onclick = () => sock && sock.send({ t: "finish" });
$("againBtn").onclick = () => sock && sock.send({ t: "restart" });
$("csvBtn").onclick = downloadCSV;
// "New session" goes back to the setup screen so topics and difficulty can be changed.
$("newRoomBtn").onclick = () => {
  if (sock) sock.close();
  sock = null; state = null;
  store("local", "hseq_host_code", null); store("local", "hseq_host_key", null);
  $("roomChip").classList.add("hidden");
  $("resumeBox").classList.add("hidden");
  $("conn").classList.add("off"); $("connText").textContent = "Offline";
  show("s-start");
};
$("topics").addEventListener("change", (e) => {
  const cb = e.target;
  if (cb.type !== "checkbox") return;
  if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
  cb.closest(".topic").classList.toggle("on", cb.checked);
  updateSummary();
});
$("levels").addEventListener("change", (e) => {
  if (e.target.name !== "lvl") return;
  level = e.target.value;
  renderTopics();
});
$("selAll").onclick = () => { catalog?.forEach((p) => selected.add(p.ref)); renderTopics(); };
$("selNone").onclick = () => { selected.clear(); renderTopics(); };
$("names").addEventListener("click", (e) => {
  const pid = e.target?.dataset?.kick;
  if (pid && sock) sock.send({ t: "kick", pid });
});
$("fsBtn").onclick = () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.();
};
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "LABEL") return;
  if (e.key === " " || e.key === "ArrowRight") {
    if (!state) return;
    if (state.phase === "lobby" && state.players.length) sock.send({ t: "start" });
    else if (state.phase === "reveal") sock.send({ t: state.qIndex + 1 >= state.total ? "finish" : "next" });
    e.preventDefault();
  }
});

loadCatalog();

const prev = saved();
if (prev) {
  $("resumeBox").classList.remove("hidden");
  $("resumeCode").textContent = prev.code;
  $("resumeBtn").onclick = () => connect(prev.code, prev.key);
}
show("s-start");
