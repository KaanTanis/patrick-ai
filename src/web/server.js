import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";
import { createLogger } from "../logger.js";

const log = createLogger("web");
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
 * Güvenlik:
 *  - Sadece host parametresine bağlanır (varsayılan 127.0.0.1)
 *  - Random session token: index.html sadece doğru ?token=… ile döner
 *  - WebSocket'te ilk mesaj olarak {type:"auth", token} gerekir; yanlışsa kapanır
 *  - WebSocket upgrade'de Origin header'ı kontrol edilir (sadece kendi origin'i)
 */
export async function startWebServer({ host, port, getAgent, bus }) {
  const token = crypto.randomBytes(24).toString("base64url");
  const expectedOrigin = `http://${host}:${port}`;

  const server = http.createServer((req, res) => handleHttp(req, res, token));

  // Sadece doğru Origin'den + doğru path'ten upgrade'e izin ver
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin) {
      log.warn("ws upgrade reddedildi (origin):", origin);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if (req.url.split("?")[0] !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const pending = new Map();
  let _isAuth = new WeakSet();

  wss.on("connection", (ws) => {
    const authTimer = setTimeout(() => {
      if (!_isAuth.has(ws)) {
        log.warn("ws auth timeout, soket kapat");
        try { ws.close(1008, "auth timeout"); } catch {}
      }
    }, 5000);

    ws.on("message", async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      // Auth ilk mesaj olmalı
      if (!_isAuth.has(ws)) {
        if (msg.type === "auth" && msg.token === token) {
          _isAuth.add(ws);
          clearTimeout(authTimer);
          safeSend(ws, { type: "hello", payload: { cwd: process.cwd(), model: getAgent().model } });
          for (const [id, p] of pending.entries()) {
            safeSend(ws, { type: "approval:request", payload: { id, ...p.context } });
          }
          return;
        }
        log.warn("ws yanlış token, kapat");
        try { ws.close(1008, "unauthorized"); } catch {}
        return;
      }

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

  // Bus → broadcast (sadece auth'lı client'lara)
  const eventTypes = [
    "tool:start", "tool:end",
    "shell:propose", "shell:output",
    "write:propose",
    "kill_port:propose",
    "assistant:text", "user:text",
    "agent:usage",
  ];
  for (const t of eventTypes) {
    bus.on(t, (payload) => broadcast({ type: t, payload }));
  }

  function broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1 && _isAuth.has(c)) {
        try { c.send(data); } catch {}
      }
    }
  }
  function safeSend(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch {}
  }

  await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, res);
  });

  const baseUrl = `http://${host}:${server.address().port}`;
  const url = `${baseUrl}/?token=${token}`;
  log.info("web server hazır:", url);

  return {
    url,
    baseUrl,
    token,
    close: () => new Promise((r) => { wss.close(); server.close(r); }),
    broadcast,
    listClients: () => wss.clients.size,
    registerPendingApproval: (context) => {
      const id = crypto.randomBytes(6).toString("base64url");
      const promise = new Promise((resolve) => {
        pending.set(id, { resolve, context });
      });
      broadcast({ type: "approval:request", payload: { id, ...context } });
      return { id, promise, cancel: () => { pending.delete(id); } };
    },
  };
}

function handleHttp(req, res, token) {
  const [pathname, query] = req.url.split("?");
  const params = new URLSearchParams(query || "");
  let urlPath = pathname;
  if (urlPath === "/") urlPath = "/index.html";

  // Statik asset güvenliği
  const filePath = path.join(PUBLIC_DIR, urlPath.replace(/\.\./g, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("forbidden");
  }

  // index.html: token'sız erişimde minimal bir uyarı sayfası dön; token'lı ise asıl içerik
  if (urlPath === "/index.html") {
    if (params.get("token") !== token) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><meta charset=utf-8><title>Patrick</title>
<style>body{font:14px ui-monospace,Menlo,monospace;background:#0d1117;color:#e6edf3;padding:40px;max-width:560px;margin:auto}code{background:#161b22;padding:2px 6px;border-radius:4px}</style>
<h2>Patrick — Yetkisiz erişim</h2>
<p>Bu sayfaya geçerli bir oturum token'ı ile erişebilirsin. Patrick CLI başlatıldığında terminalde verilen URL'yi kullan:</p>
<p><code>aiterm</code> ya da <code>patrick</code> komutu ile başlat → REPL banner'ında <em>web ui:</em> satırında bulacağın tam URL'yi tarayıcıya yapıştır.</p>
<p style="color:#8b949e">Token, her oturumda yeniden üretilir ve sadece o oturum boyunca geçerlidir.</p>`);
    }
    // index.html'i gönder; token JS tarafından url'den okunup WS'e iletilecek
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}
