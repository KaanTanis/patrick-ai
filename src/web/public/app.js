const $ = (s) => document.querySelector(s);
const chat = $("#chat");
const input = $("#input");
const sendBtn = $("#send");
const status = $("#status");
const cwdEl = $("#cwd");
const modelEl = $("#model");
const overlay = $("#approval-overlay");
const approvalBody = $("#approval-body");
const approvalTitle = $("#approval-title");
const btnYes = $("#approve-yes");
const btnNo = $("#approve-no");
const btnAlways = $("#approve-always");

let ws;
let currentApproval = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener("open", () => {
    setStatus("ok", "bağlı");
  });
  ws.addEventListener("close", () => {
    setStatus("bad", "bağlantı koptu — yeniden deniyor");
    setTimeout(connect, 1500);
  });
  ws.addEventListener("error", () => setStatus("bad", "hata"));
  ws.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    handle(m);
  });
}

function setStatus(cls, text) {
  status.className = "pill " + cls;
  status.textContent = text;
}

function handle(m) {
  switch (m.type) {
    case "hello":
      cwdEl.textContent = m.payload.cwd;
      modelEl.textContent = m.payload.model;
      break;
    case "user":
      addMessage("user", "siz", m.payload.text);
      break;
    case "assistant:text":
      addMessage("assistant", "patrick", m.payload.text);
      break;
    case "shell:propose":
      addToolCard("run_shell", m.payload, { proposal: true });
      break;
    case "shell:output":
      updateLastTool("run_shell", m.payload);
      break;
    case "tool:start":
      if (m.payload.name !== "run_shell") {
        addToolCard(m.payload.name, m.payload.args, { proposal: true });
      }
      break;
    case "tool:end":
      updateLastTool(m.payload.name, m.payload);
      break;
    case "kill_port:propose":
      addToolCard("kill_port", m.payload, { proposal: true });
      break;
    case "write:propose":
      addToolCard("write_file", m.payload, { proposal: true });
      break;
    case "approval:request":
      showApproval(m.payload);
      break;
    case "approval:resolved":
      if (currentApproval && currentApproval.id === m.payload.id) {
        hideApproval();
      }
      break;
    case "error":
      addError(m.payload.message);
      break;
  }
  scrollBottom();
}

function addMessage(kind, who, text) {
  const div = document.createElement("div");
  div.className = `msg ${kind}`;
  div.innerHTML = `<div class="who"></div><div class="body"></div>`;
  div.querySelector(".who").textContent = who;
  div.querySelector(".body").textContent = text;
  chat.appendChild(div);
}

function addToolCard(name, payload, { proposal }) {
  const card = document.createElement("div");
  card.className = "tool-card";
  card.dataset.tool = name;
  const summary = summarize(name, payload);
  card.innerHTML = `
    <div class="head">
      <span><span class="name">${name}</span> &nbsp;<span class="muted">${escapeHtml(summary)}</span></span>
      <span class="badge">${proposal ? "çalışıyor…" : "ok"}</span>
    </div>
    <div class="body">${escapeHtml(JSON.stringify(payload, null, 2))}</div>
  `;
  card.querySelector(".head").addEventListener("click", () => card.classList.toggle("collapsed"));
  card.classList.add("collapsed");
  chat.appendChild(card);
}

function updateLastTool(name, payload) {
  const cards = chat.querySelectorAll(`.tool-card[data-tool="${name}"]`);
  const card = cards[cards.length - 1];
  if (!card) return;
  const badge = card.querySelector(".badge");
  badge.classList.remove("ok", "bad");
  badge.classList.add(payload.ok === false ? "bad" : "ok");
  badge.textContent = payload.ok === false ? "hata" : "tamam";
  if (payload.output != null) {
    card.querySelector(".body").textContent = String(payload.output);
  }
}

function summarize(name, p) {
  if (!p) return "";
  if (name === "run_shell") return p.command || "";
  if (name === "kill_port") return `ports: ${(p.ports || p.args?.ports || []).join(", ")}`;
  if (name === "write_file") return p.path || "";
  if (name === "read_file") return p.path || "";
  if (name === "list_dir") return p.path || "(cwd)";
  return "";
}

function addError(msg) {
  const div = document.createElement("div");
  div.className = "error";
  div.textContent = "Hata: " + msg;
  chat.appendChild(div);
}

function scrollBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function send() {
  const text = input.value.trim();
  if (!text || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ type: "user", payload: { text } }));
  input.value = "";
}

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
sendBtn.addEventListener("click", send);

// ---- onay modalı ----
function showApproval(payload) {
  currentApproval = payload;
  let title = "Onay isteniyor";
  if (payload.kind === "shell") title = "Shell komutu onayı";
  else if (payload.kind === "kill_port") title = "Süreç sonlandırma onayı";
  else if (payload.kind === "write") title = "Dosya yazma onayı";
  approvalTitle.textContent = title;
  approvalBody.textContent = formatApprovalBody(payload);
  btnAlways.hidden = !payload.suggestedPattern;
  overlay.classList.remove("hidden");
}
function hideApproval() {
  overlay.classList.add("hidden");
  currentApproval = null;
}
function answer(decision) {
  if (!currentApproval || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: "approval:response",
    payload: { id: currentApproval.id, decision },
  }));
  hideApproval();
}
function formatApprovalBody(p) {
  if (p.kind === "shell") {
    return `Komut:  ${p.command}\nAmaç:  ${p.purpose || "-"}\nRisk:  ${p.risk}${p.reason ? `\nNeden: ${p.reason}` : ""}${p.suggestedPattern ? `\n\n"Her zaman" seçilirse şu kural eklenir:\n  ${p.suggestedPattern}` : ""}`;
  }
  if (p.kind === "kill_port") {
    const procs = (p.procs || []).map((pp) => `  • ${pp.command} (PID ${pp.pid}, ${pp.user}, ${pp.port})`).join("\n");
    return `Portlar: ${p.ports?.join(", ")}\nSinyal:  ${p.force ? "SIGKILL (-9)" : "SIGTERM (-15)"}\nHedef süreçler:\n${procs}`;
  }
  if (p.kind === "write") {
    return `Dosya: ${p.path}\nAmaç: ${p.purpose || "-"}\nBoyut: ${p.size} bayt`;
  }
  return JSON.stringify(p, null, 2);
}

btnYes.addEventListener("click", () => answer("yes"));
btnNo.addEventListener("click", () => answer("no"));
btnAlways.addEventListener("click", () => answer("always"));

connect();
