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
let qrModel = null;      // the generated QR code, reused to draw the shareable image
let joinCode = "";

function renderQR(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  qrModel = qr;
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
  joinCode = code;
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


// ---------- Share the QR card (link + image) ----------
function shareText() { return `Join the Live HSE Quiz by NBTC HSE Team — room code ${joinCode}`; }

function loadImg(src) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}
function spacedText(ctx, text, cx, y, spacing) {
  // centre text with letter spacing (canvas letterSpacing is not supported everywhere)
  const widths = [...text].map((ch) => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (text.length - 1);
  let x = cx - total / 2;
  ctx.textAlign = "left";
  [...text].forEach((ch, i) => { ctx.fillText(ch, x, y); x += widths[i] + spacing; });
  ctx.textAlign = "center";
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
// Draws the whole join card — logo, title, QR, room code and link — as a 1080×1350 PNG.
async function shareImageBlob() {
  if (!qrModel) return null;
  const W = 1080, H = 1350, url = joinLink(joinCode);
  const font = getComputedStyle(document.body).fontFamily;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const ctx = c.getContext("2d");
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#eaf3fe"); bg.addColorStop(.55, "#f7f7f9"); bg.addColorStop(1, "#fdf1e6");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff"; roundRect(ctx, 60, 60, W - 120, H - 120, 56); ctx.fill();
  ctx.strokeStyle = "#e6e6e8"; ctx.lineWidth = 2; ctx.stroke();
  const logo = await loadImg("nbtc-logo.png");
  if (logo) { const lh = 64, lw = logo.width * lh / logo.height; ctx.drawImage(logo, (W - lw) / 2, 120, lw, lh); }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#1d1d1f";
  ctx.font = `600 64px ${font}`; ctx.fillText("Live HSE Quiz", W / 2, 268);
  ctx.fillStyle = "#707070"; ctx.font = `400 32px ${font}`; ctx.fillText("Scan to join", W / 2, 318);
  // QR code
  const n = qrModel.getModuleCount(), size = 600, cell = Math.floor(size / n), qs = cell * n;
  const qx = Math.round((W - qs) / 2), qy = 370;
  ctx.fillStyle = "#ffffff"; ctx.fillRect(qx - 24, qy - 24, qs + 48, qs + 48);
  ctx.fillStyle = "#000000";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (qrModel.isDark(r, col)) ctx.fillRect(qx + col * cell, qy + r * cell, cell, cell);
  const below = qy + qs + 96;
  ctx.fillStyle = "#707070"; ctx.font = `400 28px ${font}`; ctx.fillText("or open the link and enter room code", W / 2, below);
  ctx.fillStyle = "#1d1d1f"; ctx.font = `600 104px ${font}`; spacedText(ctx, joinCode, W / 2, below + 120, 22);
  ctx.fillStyle = "#0066cc"; let fs = 30; ctx.font = `500 ${fs}px ${font}`;
  while (ctx.measureText(url).width > W - 200 && fs > 18) { fs -= 1; ctx.font = `500 ${fs}px ${font}`; }
  ctx.fillText(url, W / 2, below + 186);
  return new Promise((res) => c.toBlob(res, "image/png"));
}
async function shareFile() {
  const blob = await shareImageBlob();
  return blob ? new File([blob], `HSE-Quiz-${joinCode}.png`, { type: "image/png" }) : null;
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch {}
  try {
    const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch { return false; }
}
function setShareMenu(open) {
  $("shareMenu").classList.toggle("hidden", !open);
  $("shareBtn").setAttribute("aria-expanded", String(open));
  if (open) $("shareMenu").querySelector("button:not(.hidden)")?.focus();
}
async function doShare(kind) {
  const url = joinLink(joinCode), text = shareText();
  setShareMenu(false);
  try {
    if (kind === "native") {
      const file = await shareFile();
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) await navigator.share({ title: "Live HSE Quiz", text: `${text}\n${url}`, files: [file] });
      else await navigator.share({ title: "Live HSE Quiz", text, url });
    } else if (kind === "copy") {
      toast((await copyText(url)) ? "Join link copied" : "Could not copy — select the link below the code");
    } else if (kind === "copyimg") {
      const blob = await shareImageBlob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("QR image copied — paste it into an email, chat or slide");
    } else if (kind === "download") {
      const blob = await shareImageBlob();
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `HSE-Quiz-${joinCode}.png`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    } else if (kind === "whatsapp") {
      window.open(`https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`, "_blank", "noopener");
    } else if (kind === "email") {
      location.href = `mailto:?subject=${encodeURIComponent("Join the Live HSE Quiz")}&body=${encodeURIComponent(`${text}\n\n${url}\n\nOpen the link on your phone, enter your name and wait for the first question.`)}`;
    }
  } catch (e) {
    if (e && e.name !== "AbortError") toast("Sharing is not available here — use Copy link instead");
  }
}
if (!navigator.share) $("shareNative").classList.add("hidden");
if (!(navigator.clipboard && window.ClipboardItem)) $("shareCopyImg").classList.add("hidden");
$("shareBtn").onclick = (e) => { e.stopPropagation(); setShareMenu($("shareMenu").classList.contains("hidden")); };
$("shareMenu").addEventListener("click", (e) => { const b = e.target.closest("button[data-share]"); if (b) doShare(b.dataset.share); });
document.addEventListener("click", (e) => { if (!e.target.closest(".share-wrap")) setShareMenu(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("shareMenu").classList.contains("hidden")) { setShareMenu(false); $("shareBtn").focus(); } });

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
