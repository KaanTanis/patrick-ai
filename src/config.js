// Tüm runtime ayarlarının ve sabitlerin tek noktası.
// Yeni bir ayar eklerken: (1) burada DEFAULTS'a ekle, (2) loadConfig'te env'den oku.
//
// Tasarım kuralı: kod içinde process.env okuma — sadece bu dosyada.

import path from "node:path";
import os from "node:os";

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

  logLevel: "warn",   // silent | error | warn | info | debug
};

function bool(v, fallback) {
  if (v == null) return fallback;
  return /^(true|1|yes|on)$/i.test(String(v));
}
function num(v, fallback) {
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Çevre değişkenlerini ve isteğe bağlı override'ları birleştirip donmuş bir
 * config nesnesi döndürür. .env'in dotenv tarafından yüklenmiş olduğunu varsayar.
 */
export function loadConfig(overrides = {}) {
  const env = process.env;
  const cfg = {
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

    logLevel: (env.PATRICK_LOG_LEVEL || DEFAULTS.logLevel).toLowerCase(),

    paths: {
      patrickDir: PATRICK_DIR,
      historyFile: HISTORY_FILE,
    },

    ...overrides,
  };
  return Object.freeze(cfg);
}
