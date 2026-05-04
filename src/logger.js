// Hafif yapısal logger. console.log spam'inden kaçınmak için.
//
// Kullanım:
//   import { createLogger } from "./logger.js";
//   const log = createLogger("agent");
//   log.debug("step", { step });
//
// LOG_LEVEL env (silent|error|warn|info|debug) ile filtrelenir.
// info/debug stderr'a yazılır ki normal CLI çıktısına karışmasın.

import pc from "picocolors";

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

let _level = LEVELS.warn;
export function setLogLevel(name) {
  _level = LEVELS[(name || "warn").toLowerCase()] ?? LEVELS.warn;
}

function fmt(parts) {
  return parts.map((p) =>
    typeof p === "string" ? p : (() => { try { return JSON.stringify(p); } catch { return String(p); } })()
  ).join(" ");
}

function emit(stream, color, label, ns, args) {
  const time = new Date().toISOString().slice(11, 23);
  stream.write(`${pc.dim(time)} ${color(label.padEnd(5))} ${pc.dim(ns.padEnd(8))} ${fmt(args)}\n`);
}

export function createLogger(namespace) {
  return {
    error: (...a) => { if (_level >= LEVELS.error) emit(process.stderr, pc.red,    "error", namespace, a); },
    warn:  (...a) => { if (_level >= LEVELS.warn)  emit(process.stderr, pc.yellow, "warn",  namespace, a); },
    info:  (...a) => { if (_level >= LEVELS.info)  emit(process.stderr, pc.cyan,   "info",  namespace, a); },
    debug: (...a) => { if (_level >= LEVELS.debug) emit(process.stderr, pc.dim,    "debug", namespace, a); },
  };
}
