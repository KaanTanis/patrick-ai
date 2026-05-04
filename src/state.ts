// Patrick'in kalıcı kişisel durumu: izinler + hafıza + session tarama.
// Disk: ~/.patrick/{permissions.json, memory.json, sessions/<id>/...}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ChatMessage, Logger, SessionLogger } from "./types.js";

export const PATRICK_DIR = path.join(os.homedir(), ".patrick");
const PERMISSIONS_FILE = path.join(PATRICK_DIR, "permissions.json");
const MEMORY_FILE = path.join(PATRICK_DIR, "memory.json");
const SESSIONS_DIR = path.join(PATRICK_DIR, "sessions");

export const SESSIONS_BASE_DIR = SESSIONS_DIR;

export {
  SessionStore,
  listSessions,
  loadMeta,
  loadMessages,
  loadEvents,
  pruneOldSessions,
  findLatestSession,
} from "./session-store.js";

import { SessionStore as _Store } from "./session-store.js";

export function ensureStateDir(): void {
  fs.mkdirSync(PATRICK_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { return fallback; }
}
function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// =================================================================
// İZİNLER
// =================================================================

interface PermStore {
  allow_patterns: string[];
  deny_patterns: string[];
  session_allowed: string[];   // disk'e yazılmaz
}

const DEFAULT_PERMS: PermStore = { allow_patterns: [], deny_patterns: [], session_allowed: [] };

let permsCache: PermStore | null = null;
function loadPerms(): PermStore {
  if (permsCache) return permsCache;
  ensureStateDir();
  permsCache = { ...DEFAULT_PERMS, ...readJson<Partial<PermStore>>(PERMISSIONS_FILE, DEFAULT_PERMS) };
  permsCache.session_allowed = [];
  return permsCache;
}
function savePerms(): void {
  const p = loadPerms();
  const persisted = { allow_patterns: p.allow_patterns, deny_patterns: p.deny_patterns };
  writeJson(PERMISSIONS_FILE, persisted);
}

export function isAlwaysAllowed(cmd: string): boolean {
  const p = loadPerms();
  for (const pat of p.allow_patterns) {
    try { if (new RegExp(pat).test(cmd)) return true; } catch { /* invalid regex, skip */ }
  }
  return p.session_allowed.includes(cmd);
}

export function isAlwaysDenied(cmd: string): boolean {
  const p = loadPerms();
  for (const pat of p.deny_patterns) {
    try { if (new RegExp(pat).test(cmd)) return true; } catch { /* invalid regex, skip */ }
  }
  return false;
}

export function rememberAllowPattern(pattern: string): void {
  const p = loadPerms();
  if (!p.allow_patterns.includes(pattern)) {
    p.allow_patterns.push(pattern);
    savePerms();
  }
}
export function rememberDenyPattern(pattern: string): void {
  const p = loadPerms();
  if (!p.deny_patterns.includes(pattern)) {
    p.deny_patterns.push(pattern);
    savePerms();
  }
}
export function allowOnceForSession(cmd: string): void {
  loadPerms().session_allowed.push(cmd);
}
export function listPermissions(): PermStore {
  return { ...loadPerms() };
}
export function clearAllowPatterns(): void {
  loadPerms().allow_patterns = [];
  savePerms();
}

/**
 * Bir komuttan kabaca bir "imza" (regex pattern) üret.
 *   "kill 1234"           -> "^kill \\d+$"
 *   "npm install lodash"  -> "^npm install\\b.*"
 */
export function suggestPermissionPattern(cmd: string): string {
  let p = cmd.trim()
    .replace(/\s+/g, " ")
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m);
  p = p.replace(/\b\d+\b/g, "\\d+");
  const parts = p.split(" ");
  if (parts.length > 2) p = parts.slice(0, 2).join(" ") + "\\b.*";
  else p = "^" + p + "$";
  if (!p.startsWith("^")) p = "^" + p;
  return p;
}

// =================================================================
// MEMORY
// =================================================================

export interface MemoryNote {
  id: string;
  ts: string;
  text: string;
  tags?: string[];
}

interface MemoryStore { notes: MemoryNote[]; }
const DEFAULT_MEMORY: MemoryStore = { notes: [] };

export function loadMemory(): MemoryStore {
  ensureStateDir();
  return { ...DEFAULT_MEMORY, ...readJson<Partial<MemoryStore>>(MEMORY_FILE, DEFAULT_MEMORY) };
}

export function rememberNote(text: string, tags: string[] = []): MemoryNote {
  const mem = loadMemory();
  const note: MemoryNote = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    text: String(text).trim(),
    tags,
  };
  mem.notes.push(note);
  writeJson(MEMORY_FILE, mem);
  return note;
}

export function recallNotes(query: string = "", limit: number = 10): MemoryNote[] {
  const mem = loadMemory();
  if (!query) return mem.notes.slice(-limit);
  const q = query.toLowerCase();
  return mem.notes
    .filter((n) => n.text.toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q)))
    .slice(-limit);
}

export function forgetNote(id: string): boolean {
  const mem = loadMemory();
  const before = mem.notes.length;
  mem.notes = mem.notes.filter((n) => n.id !== id);
  writeJson(MEMORY_FILE, mem);
  return before !== mem.notes.length;
}

// =================================================================
// SessionLogger (geriye uyumlu façade — SessionStore sarmalar)
// =================================================================

export interface NewSessionLoggerOpts {
  model?: string;
  persistChunks?: boolean;
  log?: Logger;
}

export function newSessionLogger(opts: NewSessionLoggerOpts = {}): SessionLogger {
  ensureStateDir();
  const store = _Store.create({
    baseDir: SESSIONS_DIR,
    model: opts.model,
    persistChunks: opts.persistChunks,
    log: opts.log,
  });
  return {
    id: store.id,
    store,
    log(type: string, payload: unknown): void { store.appendEvent(type, payload); },
    saveMessages(messages: ChatMessage[]): void { store.saveMessages(messages); },
    close(): Promise<void> { return store.close(); },
  };
}
