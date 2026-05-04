// Patrick'in kalıcı durumu. Her şey ~/.patrick/ altında, JSON.
// İçerik: kullanıcı izinleri, hafıza notları, oturum geçmişi.
//
// Kullanıcı bunları manuel düzenleyebilsin diye:
//   - Hepsi düz JSON
//   - Tek dosya → tek sorumluluk
//   - .gitignore'la korunur, değiştir/sil her zaman güvenli

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const PATRICK_DIR = path.join(os.homedir(), ".patrick");
const PERMISSIONS_FILE = path.join(PATRICK_DIR, "permissions.json");
const MEMORY_FILE = path.join(PATRICK_DIR, "memory.json");
const SESSIONS_DIR = path.join(PATRICK_DIR, "sessions");

export function ensureStateDir() {
  fs.mkdirSync(PATRICK_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// =================================================================
// İZİNLER (permissions.json)
// =================================================================
// Yapı:
// {
//   "allow_patterns": ["^npm install\\b", "^lsof "],   // her zaman izinli regex'ler
//   "deny_patterns":  ["^rm -rf /Users/kaan/Documents"], // hep yasak (kullanıcı eklemiş)
//   "session_allowed": []  // bu oturumda 1x onaylanmışlar (diske yazılmaz)
// }

const DEFAULT_PERMS = { allow_patterns: [], deny_patterns: [], session_allowed: [] };

let permsCache = null;
function loadPerms() {
  if (permsCache) return permsCache;
  ensureStateDir();
  permsCache = { ...DEFAULT_PERMS, ...readJson(PERMISSIONS_FILE, DEFAULT_PERMS) };
  permsCache.session_allowed = []; // session boyu hafızada
  return permsCache;
}
function savePerms() {
  const p = loadPerms();
  const { session_allowed, ...persisted } = p;
  writeJson(PERMISSIONS_FILE, persisted);
}

export function isAlwaysAllowed(cmd) {
  const p = loadPerms();
  for (const pat of p.allow_patterns) {
    try { if (new RegExp(pat).test(cmd)) return true; } catch {}
  }
  for (const c of p.session_allowed) {
    if (c === cmd) return true;
  }
  return false;
}
export function isAlwaysDenied(cmd) {
  const p = loadPerms();
  for (const pat of p.deny_patterns) {
    try { if (new RegExp(pat).test(cmd)) return true; } catch {}
  }
  return false;
}
export function rememberAllowPattern(pattern) {
  const p = loadPerms();
  if (!p.allow_patterns.includes(pattern)) {
    p.allow_patterns.push(pattern);
    savePerms();
  }
}
export function rememberDenyPattern(pattern) {
  const p = loadPerms();
  if (!p.deny_patterns.includes(pattern)) {
    p.deny_patterns.push(pattern);
    savePerms();
  }
}
export function allowOnceForSession(cmd) {
  loadPerms().session_allowed.push(cmd);
}
export function listPermissions() {
  return { ...loadPerms() };
}
export function clearAllowPatterns() {
  loadPerms().allow_patterns = [];
  savePerms();
}

// Bir komuttan kabaca bir "imza" (regex pattern) üret. Örn:
//   "npm install lodash"   -> "^npm install\\b"
//   "kill 12345"           -> "^kill \\d+$"
//   "lsof -i :3000"        -> "^lsof -i :\\d+"
// Sayıları rakam joker'i, dosya yollarını .* yapıyoruz.
export function suggestPermissionPattern(cmd) {
  let p = cmd.trim()
    .replace(/\s+/g, " ")
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => "\\" + m); // regex escape
  // Sayıları joker yap
  p = p.replace(/\b\d+\b/g, "\\d+");
  // İlk iki tokendan sonrası serbest olsun
  const parts = p.split(" ");
  if (parts.length > 2) p = parts.slice(0, 2).join(" ") + "\\b.*";
  else p = "^" + p + "$";
  if (!p.startsWith("^")) p = "^" + p;
  return p;
}

// =================================================================
// MEMORY (memory.json)
// =================================================================
// Model çağrılarıyla biriken kalıcı notlar. Kullanıcı /memory komutuyla görüp düzenleyebilir.
// Yapı: { notes: [{ id, ts, text, tags? }] }

const DEFAULT_MEMORY = { notes: [] };

export function loadMemory() {
  ensureStateDir();
  return { ...DEFAULT_MEMORY, ...readJson(MEMORY_FILE, DEFAULT_MEMORY) };
}
export function rememberNote(text, tags = []) {
  const mem = loadMemory();
  const note = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    ts: new Date().toISOString(),
    text: String(text).trim(),
    tags,
  };
  mem.notes.push(note);
  writeJson(MEMORY_FILE, mem);
  return note;
}
export function recallNotes(query = "", limit = 10) {
  const mem = loadMemory();
  if (!query) return mem.notes.slice(-limit);
  const q = query.toLowerCase();
  return mem.notes
    .filter((n) => n.text.toLowerCase().includes(q) || (n.tags || []).some((t) => t.toLowerCase().includes(q)))
    .slice(-limit);
}
export function forgetNote(id) {
  const mem = loadMemory();
  const before = mem.notes.length;
  mem.notes = mem.notes.filter((n) => n.id !== id);
  writeJson(MEMORY_FILE, mem);
  return before !== mem.notes.length;
}

// =================================================================
// SESSIONS (sessions/<id>.json) — opsiyonel, oturum log'u
// =================================================================

export function newSessionLogger() {
  ensureStateDir();
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(SESSIONS_DIR, `${id}.json`);
  const events = [];
  let pending = false;
  const flush = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      try { writeJson(file, { id, events }); } catch {}
      pending = false;
    }, 250);
  };
  return {
    id,
    file,
    log(type, payload) { events.push({ ts: Date.now(), type, payload }); flush(); },
  };
}
