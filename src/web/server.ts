import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import type { EventEmitter } from "node:events";
import { createLogger } from "../logger.js";
import type {
  ApprovalContext, ConfirmerDecision, Logger,
  ServerEvent, ClientMessage,
} from "../types.js";
import type { SessionStore } from "../session-store.js";

const log: Logger = createLogger("web");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

interface AgentLike {
  model: string;
  send(text: string): Promise<string>;
}

export interface WebServerOpts {
  host: string;
  port: number;
  getAgent: () => AgentLike;
  bus: EventEmitter;
  sessionStore?: SessionStore | null;
}

interface PendingApproval {
  resolve: (decision: ConfirmerDecision) => void;
  context: ApprovalContext & { message?: string };
}

export interface WebServerHandle {
  url: string;
  baseUrl: string;
  token: string;
  close(): Promise<void>;
  broadcast(msg: ServerEvent): void;
  listClients(): number;
  registerPendingApproval(context: ApprovalContext & { message?: string }): {
    id: string;
    promise: Promise<ConfirmerDecision>;
    cancel: () => void;
  };
}

export async function startWebServer({
  host, port, getAgent, bus, sessionStore = null,
}: WebServerOpts): Promise<WebServerHandle> {
  const token = crypto.randomBytes(24).toString("base64url");
  const expectedOrigin = `http://${host}:${port}`;

  const server = http.createServer((req, res) => handleHttp(req, res, { token, sessionStore }));

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (origin && origin !== expectedOrigin) {
      log.warn("ws upgrade reddedildi (origin):", origin);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    if ((req.url || "").split("?")[0] !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const pending = new Map<string, PendingApproval>();
  const isAuth = new WeakSet<WebSocket>();

  wss.on("connection", (ws: WebSocket) => {
    const authTimer = setTimeout(() => {
      if (!isAuth.has(ws)) {
        log.warn("ws auth timeout, soket kapat");
        try { ws.close(1008, "auth timeout"); } catch { /* ignore */ }
      }
    }, 5000);

    ws.on("message", async (raw) => {
      let msg: ClientMessage;
      try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }

      if (!isAuth.has(ws)) {
        if (msg.type === "auth" && msg.token === token) {
          isAuth.add(ws);
          clearTimeout(authTimer);
          safeSend(ws, { type: "hello", payload: {
            cwd: process.cwd(),
            model: getAgent().model,
            sessionId: sessionStore?.id ?? null,
            cursor: sessionStore?.eventCount ?? 0,
          }});
          for (const [id, p] of pending.entries()) {
            safeSend(ws, { type: "approval:request", payload: { id, ...p.context } });
          }
          return;
        }
        log.warn("ws yanlış token, kapat");
        try { ws.close(1008, "unauthorized"); } catch { /* ignore */ }
        return;
      }

      if (msg.type === "user") {
        const text = String(msg.payload?.text || "").trim();
        if (!text) return;
        try {
          await getAgent().send(text);
        } catch (err) {
          broadcast({ type: "error", payload: { message: (err as Error)?.message || String(err) } });
        }
      } else if (msg.type === "approval:response") {
        const { id, decision } = msg.payload;
        const p = pending.get(id);
        if (p) {
          pending.delete(id);
          broadcast({ type: "approval:resolved", payload: { id, decision } });
          p.resolve(decision);
        }
      } else if (msg.type === "ping") {
        safeSend(ws, { type: "pong" } as unknown as ServerEvent);
      }
    });
  });

  // Bus → broadcast (cli.js zaten persist ediyor; biz sadece WS'e yansıtırız).
  const eventTypes = [
    "tool:start", "tool:end",
    "shell:propose", "shell:output",
    "write:propose", "kill_port:propose",
    "assistant:start", "assistant:chunk", "assistant:done", "assistant:text",
    "user:text",
    "agent:usage",
  ] as const;
  for (const t of eventTypes) {
    bus.on(t, (payload: unknown) => {
      const persisted = sessionStore && wasPersisted(sessionStore, t);
      const evt = persisted
        ? { type: t, payload, cursor: sessionStore!.eventCount }
        : { type: t, payload };
      broadcast(evt as unknown as ServerEvent);
    });
  }

  function broadcast(msg: ServerEvent): void {
    const data = JSON.stringify(msg);
    for (const c of wss.clients) {
      if (c.readyState === 1 && isAuth.has(c)) {
        try { c.send(data); } catch { /* ignore */ }
      }
    }
  }
  function safeSend(ws: WebSocket, msg: ServerEvent): void {
    try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
  }

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(port, host, () => res());
  });

  const addr = server.address();
  const actualPort = (typeof addr === "object" && addr) ? addr.port : port;
  const baseUrl = `http://${host}:${actualPort}`;
  const url = `${baseUrl}/?token=${token}`;
  log.info("web server hazır:", url);

  return {
    url,
    baseUrl,
    token,
    close: () => new Promise<void>((r) => { wss.close(); server.close(() => r()); }),
    broadcast,
    listClients: () => wss.clients.size,
    registerPendingApproval: (context) => {
      const id = crypto.randomBytes(6).toString("base64url");
      const promise = new Promise<ConfirmerDecision>((resolve) => {
        pending.set(id, { resolve, context });
      });
      broadcast({ type: "approval:request", payload: { id, ...context } });
      return { id, promise, cancel: () => { pending.delete(id); } };
    },
  };
}

function wasPersisted(store: SessionStore, type: string): boolean {
  if (type === "assistant:start" || type === "assistant:done") return false;
  if (type === "assistant:chunk" && !store.persistChunks) return false;
  return true;
}

function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  { token, sessionStore }: { token: string; sessionStore: SessionStore | null }
): void {
  const [pathname, query] = (req.url || "").split("?");
  const params = new URLSearchParams(query || "");

  if (pathname === "/api/events") {
    if (params.get("token") !== token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end('{"error":"unauthorized"}');
      return;
    }
    const cursor = parseInt(params.get("cursor") || "0", 10) || 0;
    const events = sessionStore ? sessionStore.getEventsSince(cursor) : [];
    const head = sessionStore ? sessionStore.eventCount : cursor;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      sessionId: sessionStore?.id || null,
      events,
      cursor: head,
    }));
    return;
  }

  let urlPath = pathname || "/";
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(PUBLIC_DIR, urlPath.replace(/\.\./g, ""));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end("forbidden"); return;
  }

  if (urlPath === "/index.html" && params.get("token") !== token) {
    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><meta charset=utf-8><title>Patrick</title>
<style>body{font:14px ui-monospace,Menlo,monospace;background:#0d1117;color:#e6edf3;padding:40px;max-width:560px;margin:auto}code{background:#161b22;padding:2px 6px;border-radius:4px}</style>
<h2>Patrick — Yetkisiz erişim</h2>
<p>Bu sayfaya geçerli bir oturum token'ı ile erişebilirsin. Patrick CLI başlatıldığında terminalde verilen URL'yi kullan:</p>
<p><code>patrick</code> komutu ile başlat → REPL banner'ında <em>web ui:</em> satırında bulacağın tam URL'yi tarayıcıya yapıştır.</p>
<p style="color:#8b949e">Token, her oturumda yeniden üretilir ve sadece o oturum boyunca geçerlidir.</p>`);
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

