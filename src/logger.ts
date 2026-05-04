// Hafif yapısal logger — console.log spam'inden kaçınmak için.
// LOG_LEVEL env (silent|error|warn|info|debug) ile filtrelenir.

import pc from "picocolors";
import type { Logger, LogLevel } from "./types.js";

const LEVELS: Record<LogLevel, number> = {
  silent: 0, error: 1, warn: 2, info: 3, debug: 4,
};

let _level: number = LEVELS.warn;

export function setLogLevel(name: LogLevel | string): void {
  const lower = String(name || "warn").toLowerCase() as LogLevel;
  _level = LEVELS[lower] ?? LEVELS.warn;
}

function fmt(parts: unknown[]): string {
  return parts.map((p) =>
    typeof p === "string" ? p : tryStringify(p)
  ).join(" ");
}
function tryStringify(x: unknown): string {
  try { return JSON.stringify(x); } catch { return String(x); }
}

type Color = (s: string) => string;
function emit(stream: NodeJS.WriteStream, color: Color, label: string, ns: string, args: unknown[]): void {
  const time = new Date().toISOString().slice(11, 23);
  stream.write(`${pc.dim(time)} ${color(label.padEnd(5))} ${pc.dim(ns.padEnd(8))} ${fmt(args)}\n`);
}

export function createLogger(namespace: string): Logger {
  return {
    error: (...a) => { if (_level >= LEVELS.error) emit(process.stderr, pc.red,    "error", namespace, a); },
    warn:  (...a) => { if (_level >= LEVELS.warn)  emit(process.stderr, pc.yellow, "warn",  namespace, a); },
    info:  (...a) => { if (_level >= LEVELS.info)  emit(process.stderr, pc.cyan,   "info",  namespace, a); },
    debug: (...a) => { if (_level >= LEVELS.debug) emit(process.stderr, pc.dim,    "debug", namespace, a); },
  };
}
