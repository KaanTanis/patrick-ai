// Per-session disk + memory store.
// Disk yapısı: ~/.patrick/sessions/<id>/{meta.json, events.jsonl, messages.json}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatMessage, Logger, SessionEvent, SessionMeta } from "./types.js";

interface CreateOpts {
  baseDir: string;
  model?: string;
  persistChunks?: boolean;
  log?: Logger;
}

export class SessionStore {
  readonly id: string;
  readonly dir: string;
  readonly persistChunks: boolean;
  readonly model: string | undefined;
  readonly log: Pick<Logger, "debug" | "warn">;

  events: SessionEvent[] = [];
  eventCount = 0;
  messageCount = 0;
  started: string;
  ended: string | null = null;
  closed = false;

  private _writeStream: fs.WriteStream | null = null;
  private _writeQueue: string[] = [];
  private _flushTimer: NodeJS.Timeout | null = null;

  private constructor(opts: { baseDir: string; id: string; model?: string; persistChunks: boolean; log: Pick<Logger, "debug" | "warn"> }) {
    this.id = opts.id;
    this.dir = path.join(opts.baseDir, opts.id);
    this.model = opts.model;
    this.persistChunks = opts.persistChunks;
    this.log = opts.log;
    this.started = new Date().toISOString();
  }

  /** Yeni bir session oluşturur ve disk yapısını kurar. */
  static create({ baseDir, model, persistChunks = false, log }: CreateOpts): SessionStore {
    // Timestamp + random suffix: aynı ms'de yaratılan iki session çakışmasın.
    const id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(2).toString("hex");
    fs.mkdirSync(path.join(baseDir, id), { recursive: true });
    const safeLog: Pick<Logger, "debug" | "warn"> = log ?? { debug() {}, warn() {} } as Pick<Logger, "debug" | "warn">;
    const s = new SessionStore({ baseDir, id, model, persistChunks, log: safeLog });
    s._writeMeta();
    s._writeStream = fs.createWriteStream(path.join(s.dir, "events.jsonl"), { flags: "a" });
    return s;
  }

  /**
   * Event'i UI replay log'una ekler.
   * @returns yeni cursor (event persist edildiyse) ya da null
   */
  appendEvent(type: string, payload: unknown): number | null {
    if (this.closed) return null;
    if (!this.persistChunks && type === "assistant:chunk") return null;
    if (type === "assistant:start" || type === "assistant:done") return null;

    const evt: SessionEvent = { ts: Date.now(), type, payload };
    this.events.push(evt);
    this.eventCount++;
    if (type === "user:text" || type === "assistant:text") this.messageCount++;

    this._writeQueue.push(JSON.stringify(evt) + "\n");
    this._scheduleFlush();
    return this.eventCount;
  }

  getEventsSince(cursor: number = 0): SessionEvent[] {
    const c = Math.max(0, Number(cursor) | 0);
    return this.events.slice(c);
  }

  saveMessages(messages: ChatMessage[]): void {
    if (this.closed) return;
    try {
      fs.writeFileSync(path.join(this.dir, "messages.json"), JSON.stringify(messages));
    } catch (err) {
      this.log.warn("messages snapshot yazılamadı:", (err as Error).message);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ended = new Date().toISOString();
    await this._flush();
    if (this._writeStream) {
      await new Promise<void>((res) => this._writeStream!.end(() => res()));
      this._writeStream = null;
    }
    this._writeMeta();
  }

  private _scheduleFlush(): void {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { void this._flush(); }, 250);
  }

  private async _flush(): Promise<void> {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    if (!this._writeStream || this._writeQueue.length === 0) return;
    const chunk = this._writeQueue.join("");
    this._writeQueue.length = 0;
    return new Promise<void>((res) => this._writeStream!.write(chunk, () => res()));
  }

  private _writeMeta(): void {
    try {
      const meta: SessionMeta = {
        id: this.id,
        started: this.started,
        ended: this.ended,
        model: this.model,
        eventCount: this.eventCount,
        messageCount: this.messageCount,
      };
      fs.writeFileSync(path.join(this.dir, "meta.json"), JSON.stringify(meta, null, 2));
    } catch (err) {
      this.log.warn("meta.json yazılamadı:", (err as Error).message);
    }
  }
}

// ---- statik yardımcılar ----

export function listSessions(baseDir: string): string[] {
  try {
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch { return []; }
}

export function loadMeta(baseDir: string, id: string): SessionMeta | null {
  try { return JSON.parse(fs.readFileSync(path.join(baseDir, id, "meta.json"), "utf8")) as SessionMeta; }
  catch { return null; }
}

export function loadMessages(baseDir: string, id: string): ChatMessage[] | null {
  try { return JSON.parse(fs.readFileSync(path.join(baseDir, id, "messages.json"), "utf8")) as ChatMessage[]; }
  catch { return null; }
}

export function loadEvents(baseDir: string, id: string): SessionEvent[] {
  try {
    const raw = fs.readFileSync(path.join(baseDir, id, "events.jsonl"), "utf8");
    return raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent);
  } catch { return []; }
}

export function pruneOldSessions(baseDir: string, maxAgeDays: number, log?: Logger): number {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) return 0;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let deleted = 0;
  for (const id of listSessions(baseDir)) {
    const dir = path.join(baseDir, id);
    let ageBasis: number | null = null;
    const meta = loadMeta(baseDir, id);
    if (meta?.started) {
      const t = Date.parse(meta.started);
      if (Number.isFinite(t)) ageBasis = t;
    }
    if (ageBasis == null) {
      try { ageBasis = fs.statSync(dir).mtimeMs; } catch { continue; }
    }
    if (ageBasis < cutoff) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        deleted++;
        log?.debug?.("session silindi:", id);
      } catch (err) {
        log?.warn?.("session silinemedi:", id, (err as Error).message);
      }
    }
  }
  return deleted;
}

export function findLatestSession(baseDir: string): string | null {
  const all = listSessions(baseDir);
  return all.length ? all[0]! : null;
}
