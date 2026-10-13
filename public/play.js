// Participant (phone / laptop) logic
const params = new URLSearchParams(location.search);
let room = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
let sock = null, state = null, me = null, tick = null, pendingChoice = null;

if (room.length === 6) {
  $("codeField").classList.add("hidden");
  $("roomLbl").textContent = room;
}
const savedName = store("local", "hseq_name");
if (savedName) $("name").value = savedName;

function pidKey() { return `hseq_pid_${room}`; }

function connect(name) {
  if (sock) sock.close();
  $("roomLbl").textContent = room;
  let joined = false, failures = 0;
  sock = liveSocket(`/ws/${room}`, {
    onOpen: () => {
      sock.send({ t: "join", name, pid: store("local", pidKey()) });
    },
    onMessage: (m) => {
      failures = 0;
      if (m.t === "joined") {
        joined = true;
        me = m;
        store("local", pidKey(), m.pid);
        $("meName").textContent = m.name;
        $("footer").textContent = `Playing as ${m.name}`;
      } else if (m.t === "state") {
        state = m; render();
      } else if (m.t === "error") {
        toast(m.message);
        if (!joined) { sock.close(); show("p-join"); $("joinBtn").disabled = false; }
      } else if (m.t === "kicked") {
        store("local", pidKey(), null);
        toast("You were removed from the quiz by the presenter.");
        show("p-join"); $("joinBtn").disabled = false;
      }
    },
    onStatus: (on) => {
      $("conn").classList.toggle("off", !on);
      if (!on && ++failures > 4 && !joined) {
        sock.close();
        toast("Room not found. Check the code with your presenter.");
        $("codeField").classList.remove("hidden");
        show("p-join"); $("joinBtn").disabled = false;
      }
    },
  });
}

function render() {
  const s = state;
  if (s.phase === "lobby") {
    show("p-lobby"); stopTick();
    $("lobbyCount").textContent = s.playerCount;
    $("lobbyTotal").textContent = s.total;
    return;
  }
  if (s.phase === "question" || s.phase === "reveal") return renderQuestion();
  if (s.phase === "final") return renderFinal();
}

let renderedQ = -1;
function renderQuestion() {
  show("p-question");
  const s = state, q = s.question;
  const reveal = s.phase === "reveal";
  if (renderedQ !== s.qIndex) { pendingChoice = null; renderedQ = s.qIndex; window.scrollTo(0, 0); }
  $("pqNum").textContent = s.qIndex + 1;
  $("pqTotal").textContent = s.total;
  $("pqRef").textContent = q.ref;
  $("pqText").textContent = q.q;
  const mine = s.myAnswer ? s.myAnswer.choice : pendingChoice;
  const locked = mine !== null && mine !== undefined;
  const box = $("pbtns");
  box.className = "pbtns" + (reveal ? " locked revealed" : locked ? " locked" : "");
  box.innerHTML = q.options.map((o, i) => {
    const cls = [i === mine ? "mine" : "", reveal && i === q.answer ? "right" : ""].join(" ");
    return `<button class="pbtn ${cls}" data-i="${i}" ${locked || reveal ? "disabled" : ""}><span class="shape">${SHAPES[i]}</span><span>${esc(o)}</span></button>`;
  }).join("");

  const st = $("pStatus");
  if (reveal) {
    stopTick();
    $("pTime").textContent = "0";
    $("pBar").firstElementChild.style.width = "0%";
    const a = s.myAnswer;
    if (!a) st.innerHTML = `<div class="result none">⏱ No answer — 0 points</div>`;
    else if (a.correct) st.innerHTML = `<div class="result ok">✔ Correct! +${a.points} points</div>`;
    else st.innerHTML = `<div class="result no">✘ Not this time — correct answer: ${LETTERS[q.answer]}</div>`;
    if (q.source) st.innerHTML += `<div class="pref"><div class="lbl">Reference</div><b>${esc(q.ref)}${q.procedure ? " – " + esc(q.procedure) : ""}</b>${esc(q.source)}</div>`;
    if (s.me) st.innerHTML += `<div class="stat"><div><b>${s.me.rank ?? "–"}</b>rank of ${s.me.of}</div><div><b>${s.me.score.toLocaleString()}</b>points</div></div>`;
  } else {
    st.innerHTML = locked ? `<div class="result none">🔒 Answer locked in — waiting for others…</div>` : "";
    startTick();
  }
}

function startTick() {
  if (tick) return;
  const step = () => {
    if (!state || state.phase !== "question") return stopTick();
    const total = state.qDeadline - state.qStart;
    const now = serverNow();
    const rem = Math.max(0, state.qDeadline - Math.max(now, state.qStart));
    $("pTime").textContent = Math.ceil(rem / 1000);
    $("pBar").firstElementChild.style.width = `${(rem / total) * 100}%`;
    $("pBar").classList.toggle("low", rem <= 10000);
  };
  step();
  tick = setInterval(step, 200);
}
function stopTick() { clearInterval(tick); tick = null; }

function renderFinal() {
  show("p-final"); stopTick();
  const s = state;
  const rank = s.me?.rank;
  $("fRank").textContent = rank ? `#${rank}` : "–";
  $("fScore").textContent = (s.me?.score || 0).toLocaleString();
  const medals = ["🥇", "🥈", "🥉"];
  $("finalEmoji").textContent = rank && rank <= 3 ? medals[rank - 1] : "🏁";
  $("finalTitle").textContent = rank === 1 ? "You won!" : rank && rank <= 3 ? "You made the podium!" : "Quiz complete";
  $("fPodium").innerHTML = (s.podium || []).map((p) => `<div class="row"><span class="rk">${medals[p.rank - 1]}</span><span class="nm">${esc(p.name)}</span><span class="sc">${p.score.toLocaleString()}</span></div>`).join("");
}

$("pbtns").addEventListener("click", (e) => {
  const b = e.target.closest(".pbtn");
  if (!b || !state || state.phase !== "question") return;
  if (serverNow() < state.qStart) return toast("Get ready… the timer hasn't started yet", 1500);
  const choice = Number(b.dataset.i);
  if (pendingChoice !== null || state.myAnswer) return;
  if (sock.send({ t: "answer", qIndex: state.qIndex, choice })) {
    pendingChoice = choice;
    if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
    renderQuestion();
  } else toast("Connection lost — reconnecting…");
});

$("joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (room.length !== 6) room = $("code").value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const name = $("name").value.trim();
  if (room.length !== 6) return toast("Enter the 6-character room code shown on the screen.");
  if (name.length < 2) return toast("Please enter your name.");
  store("local", "hseq_name", name);
  $("joinBtn").disabled = true;
  connect(name);
});

// Auto-rejoin after a refresh if this phone already joined this room
if (room.length === 6 && store("local", pidKey()) && savedName) connect(savedName);
else show("p-join");
