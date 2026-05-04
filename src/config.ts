// Tüm runtime ayarlarının ve sabitlerin tek noktası.
// Yeni bir ayar eklerken: (1) burada DEFAULTS'a ekle, (2) loadConfig'te env'den oku.
// Kod içinde process.env okuma — sadece bu dosyada.

import path from "node:path";
import os from "node:os";
import type { Config, LogLevel } from "./types.js";

export const PATRICK_DIR = path.join(os.homedir(), ".patrick");
export const HISTORY_FILE = path.join(os.homedir(), ".patrick-history");

const DEFAULTS = {
  model: "gpt-4o",
  autoApprove: false,

  agentMaxSteps: 25,
  toolTimeoutSec: 30,
  shellMaxOutputBytes: 10 * 1024 * 1024,
  toolResultMaxChars: 30_000,

  webEnabled: true,
  webPort: 7878,
  webOpenBrowser: false,
  webHost: "127.0.0.1",

  historySize: 500,
  memoryInjectLimit: 30,

  sessionKeepDays: 30,
  resumeOnStart: false,
  resumeMaxMessages: 30,
  persistChunks: false,

  // Summarization (Faz 3)
  compactEnabled: true,
  compactThresholdTokens: 12_000,    // gpt-4o için makul; modeli büyük/küçük ise ayarla
  compactKeepLastMessages: 10,        // kompakt sonrası saklanan tail

  logLevel: "warn" as LogLevel,
};

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v == null) return fallback;
  return /^(true|1|yes|on)$/i.test(String(v));
}
function num(v: string | undefined, fallback: number): number {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set(["silent", "error", "warn", "info", "debug"]);
function level(v: string | undefined, fallback: LogLevel): LogLevel {
  const x = (v || "").toLowerCase() as LogLevel;
  return VALID_LEVELS.has(x) ? x : fallback;
}

export function loadConfig(overrides: Partial<Config> = {}): Readonly<Config> {
  const env = process.env;
  const cfg: Config = {
    apiKey: env.OPENAI_API_KEY || "",
    model: env.PATRICK_MODEL || DEFAULTS.model,
    autoApprove: bool(env.PATRICK_AUTO_APPROVE, DEFAULTS.autoApprove),

    agentMaxSteps: num(env.PATRICK_MAX_STEPS, DEFAULTS.agentMaxSteps),
    toolTimeoutSec: num(env.PATRICK_TOOL_TIMEOUT, DEFAULTS.toolTimeoutSec),
    shellMaxOutputBytes: num(env.PATRICK_MAX_OUTPUT_BYTES, DEFAULTS.shellMaxOutputBytes),
    toolResultMaxChars: num(env.PATRICK_TOOL_RESULT_MAX, DEFAULTS.toolResultMaxChars),

    webEnabled: bool(env.PATRICK_WEB_ENABLED, DEFAULTS.webEnabled),
    webPort: num(env.PATRICK_WEB_PORT, DEFAULTS.webPort),
    webOpenBrowser: bool(env.PATRICK_WEB_OPEN, DEFAULTS.webOpenBrowser),
    webHost: env.PATRICK_WEB_HOST || DEFAULTS.webHost,

    historySize: num(env.PATRICK_HISTORY_SIZE, DEFAULTS.historySize),
    memoryInjectLimit: num(env.PATRICK_MEMORY_LIMIT, DEFAULTS.memoryInjectLimit),

    sessionKeepDays: num(env.PATRICK_SESSION_KEEP_DAYS, DEFAULTS.sessionKeepDays),
    resumeOnStart: bool(env.PATRICK_RESUME_ON_START, DEFAULTS.resumeOnStart),
    resumeMaxMessages: num(env.PATRICK_RESUME_MAX_MESSAGES, DEFAULTS.resumeMaxMessages),
    persistChunks: bool(env.PATRICK_PERSIST_CHUNKS, DEFAULTS.persistChunks),

    compactEnabled: bool(env.PATRICK_COMPACT_ENABLED, DEFAULTS.compactEnabled),
    compactThresholdTokens: num(env.PATRICK_COMPACT_THRESHOLD, DEFAULTS.compactThresholdTokens),
    compactKeepLastMessages: num(env.PATRICK_COMPACT_KEEP_LAST, DEFAULTS.compactKeepLastMessages),

    logLevel: level(env.PATRICK_LOG_LEVEL, DEFAULTS.logLevel),

    paths: {
      patrickDir: PATRICK_DIR,
      historyFile: HISTORY_FILE,
    },

    ...overrides,
  };
  return Object.freeze(cfg);
}
