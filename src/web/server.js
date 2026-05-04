import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * Patrick web sunucusu.
 *
 * @param {object} opts
 * @param {number} opts.port           Dinlenecek port
 * @param {() => any} opts.getAgent     Aktif Agent örneğini döndüren callback
 * @param {EventTarget} opts.bus       Tool/agent olaylarının yayıldığı emitter
 *                                     (.emit(event, payload) ve .on(event, fn) destekler)
 * @returns {Promise<{ url, close, broadcast, registerPendingApproval, resolveApproval, listClients }>}
 */
export async function startWebServer({ port, getAgent, bus }) {
  const server = http.createServer(handleHttp);
  const wss = new WebSocketServer({ server });

  // Bekleyen onay istekleri: pendingId -> { resolve, context }
  const pending = new Map();

  wss.on("connection", (ws) => {
    safeSend(ws, { type: "hello", payload: { cwd: process.cwd(), model: getAgent().model } });

    // Yeni bağlanan client da bekleyen onayları görmeli
    for (const [id, p] of pending.entries()) {
      safeSend(ws, { type: "approval:request", payload: { id, ...p.context } });
    }

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "user") {
        const text = String(msg.payload?.text || "").trim();
        if (!text) return;
        broadcast({ type: "user", payload: { text } });
        try {
          await getAgent().send(text);
        } catch (err) {
          broadcast({ type: "error", payload: { message: err?.message || String(err) } });
        }
      } else if (msg.type === "approval:response") {
        const { id, decision } = msg.payload || {};
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          broadcast({ type: "approval:resolved", payload: { id, decision } });
          p.resolve(decision);
        }
      } else if (msg.type === "ping") {
        safeSend(ws, { type: "pong" });
      }
    });
  });

  // Bus → tüm WS client'lara ilet
  const eventTypes = [
    "tool:start", "tool:end",
    "shell:propose", "shell:output",
    "write:propose",
    "kill_port:propose",
    "assistant:text", "user:text",
  ];
  for (const t of eventTypes) {
    bus.on(t, (payload) => broadcast({ type: t, payload }));
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1) {
        try { c.send(data); } catch {}
      }
    }
  }
  function safeSend(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, "127.0.0.1", res);
  });

  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    close: () => new Promise((r) => { wss.close(); server.close(r); }),
    broadcast,
    listClients: () => wss.clients.size,
    registerPendingApproval: (context) => {
      const id = Math.random().toString(36).slice(2, 10);
      const promise = new Promise((resolve) => {
        pending.set(id, { resolve, context });
      });
      broadcast({ type: "approval:request", payload: { id, ...context } });
      return { id, promise, cancel: () => { pending.delete(id); } };
    },
    resolveApproval: (id, decision) => {
      const p = pending.get(id);
      if (p) { pending.delete(id); broadcast({ type: "approval:resolved", payload: { id, decision } }); p.resolve(decision); }
    },
  };
}

function handleHttp(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, urlPath.replace(/\.\./g, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}
