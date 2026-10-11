// Presenter screen logic
let sock = null;
let state = null;
let tickTimer = null;
let lastNames = "";

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
    const r = await fetch("/api/rooms", { method: "POST" });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "Failed");
    store("local", "hseq_host_code", d.code);
    store("local", "hseq_host_key", d.hostKey);
    connect(d.code, d.hostKey);
  } catch (e) {
    toast("Could not create a session: " + e.message);
  } finally {
    $("createBtn").disabled = false;
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
  if (s.bankSize) $("bankSize").textContent = s.bankSize;
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
  if (reveal) $("qSource").innerHTML = `<b>${esc(q.ref)}</b> — ${esc(q.source)}`;

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
  $("timerArc").setAttribute("stroke", secs <= 10 ? "#ef4444" : "#f5b301");
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
  $("finalSub").textContent = `${ps.length} participant${ps.length === 1 ? "" : "s"} · ${state.total} questions`;
  $("finalBoard").innerHTML = ps.map((p) => `<div class="row"><span class="rk">${p.rank}</span><span class="nm">${esc(p.name)} <span class="muted" style="font-weight:400">· ${p.correct}/${state.total} correct</span></span><span class="sc">${p.score.toLocaleString()}</span></div>`).join("");
}

function downloadCSV() {
  if (!state) return;
  const rows = [["Rank", "Name", "Score", "Correct", "Questions", "Room", "Date"]];
  const date = new Date().toISOString().slice(0, 16).replace("T", " ");
  for (const p of state.players) rows.push([p.rank, p.name, p.score, p.correct, state.total, state.room, date]);
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
$("newRoomBtn").onclick = () => { if (sock) sock.close(); state = null; store("local", "hseq_host_code", null); store("local", "hseq_host_key", null); createRoom(); };
$("names").addEventListener("click", (e) => {
  const pid = e.target?.dataset?.kick;
  if (pid && sock) sock.send({ t: "kick", pid });
});
$("fsBtn").onclick = () => {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.();
};
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === " " || e.key === "ArrowRight") {
    if (!state) return;
    if (state.phase === "lobby" && state.players.length) sock.send({ t: "start" });
    else if (state.phase === "reveal") sock.send({ t: state.qIndex + 1 >= state.total ? "finish" : "next" });
    e.preventDefault();
  }
});

fetch("/api/health").then((r) => r.json()).then((d) => { if (d.questionsInBank) $("bankSize").textContent = d.questionsInBank; }).catch(() => {});

const prev = saved();
if (prev) {
  $("resumeBox").classList.remove("hidden");
  $("resumeCode").textContent = prev.code;
  $("resumeBtn").onclick = () => connect(prev.code, prev.key);
}
show("s-start");
