// Shared helpers for presenter and participant pages
const LETTERS = ["A", "B", "C", "D"];
const SHAPES = ["▲", "◆", "●", "■"];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function $(id) { return document.getElementById(id); }
function show(id) {
  document.querySelectorAll("[data-screen]").forEach((el) => el.classList.toggle("hidden", el.id !== id));
}
function store(kind, key, val) {
  try {
    const s = kind === "local" ? localStorage : sessionStorage;
    if (val === undefined) return s.getItem(key);
    if (val === null) s.removeItem(key); else s.setItem(key, val);
  } catch { return null; }
}
function toast(msg, ms = 3500) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Server clock offset so every screen counts down to the same instant.
let clockOffset = 0;
function serverNow() { return Date.now() + clockOffset; }

// Auto-reconnecting WebSocket.
function liveSocket(path, { onOpen, onMessage, onStatus }) {
  let ws, retry = 0, closedByUs = false, pingTimer;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  function open() {
    ws = new WebSocket(`${proto}//${location.host}${path}`);
    ws.onopen = () => {
      retry = 0; onStatus && onStatus(true); onOpen && onOpen(ws);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws.send(JSON.stringify({ t: "ping" })); } catch {} }, 20000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (typeof m.now === "number") clockOffset = m.now - Date.now();
      onMessage(m, ws);
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      onStatus && onStatus(false);
      if (closedByUs || e.code === 4000 || e.code === 1008) return;
      setTimeout(open, Math.min(8000, 600 * 2 ** retry++));
    };
    ws.onerror = () => {};
  }
  open();
  return {
    send: (obj) => { if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; } return false; },
    close: () => { closedByUs = true; try { ws.close(); } catch {} },
  };
}
