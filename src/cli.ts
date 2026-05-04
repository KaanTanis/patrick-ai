import "dotenv/config";
import readline, { type Interface as Readline } from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { EventEmitter } from "node:events";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";

import { loadConfig, HISTORY_FILE } from "./config.js";
import { setLogLevel, createLogger } from "./logger.js";
import { Agent } from "./agent.js";
import { buildSystemPrompt } from "./prompt.js";
import { createTerminalConfirmer, createDenyConfirmer, createCompoundConfirmer } from "./confirmer.js";
import {
  ensureStateDir, newSessionLogger,
  listPermissions, clearAllowPatterns, loadMemory, forgetNote,
  pruneOldSessions, findLatestSession, loadMessages, listSessions, loadMeta,
  SESSIONS_BASE_DIR,
} from "./state.js";
import type { Config, Confirmer, SessionLogger } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATRICK_HOME = path.join(__dirname, "..");
const log = createLogger("cli");

// Repo kökündeki .env'yi de yükle (binary nereden çağrılırsa çağrılsın)
const repoEnv = path.join(PATRICK_HOME, ".env");
if (fs.existsSync(repoEnv)) {
  for (const line of fs.readFileSync(repoEnv, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
}

interface Args {
  print: boolean;
  help: boolean;
  version: boolean;
  noWeb: boolean;
  resume: boolean;
  prompt: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { print: false, help: false, version: false, noWeb: false, resume: false, prompt: "" };
  const tokens: string[] = [];
  for (const a of argv) {
    if (a === "-p" || a === "--print") out.print = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "--no-web") out.noWeb = true;
    else if (a === "--resume") out.resume = true;
    else tokens.push(a);
  }
  out.prompt = tokens.join(" ").trim();
  return out;
}

function printUsage(cfg?: Config): void {
  console.log(`
${pc.bold("patrick")} — ChatGPT destekli, hafızalı, web UI'lı terminal asistanı

${pc.bold("Kullanım:")}
  patrick                          REPL aç (web UI da otomatik başlar)
  patrick "soru / komut"           Soruyu çalıştır, sonra REPL'de kal
  patrick -p "soru"                Tek seferlik (script): cevap ver, çık
  patrick --resume                 Son oturumun mesajlarıyla devam et
  patrick --no-web                 Web UI'ı başlatma
  patrick --help / --version

${pc.bold("REPL slash komutları:")}
  /exit, /quit, Ctrl+D             Çıkış
  /clear                           Konuşma geçmişini sıfırla
  /repair                          Bozuk mesaj geçmişini onar
  /cwd <yol>                       Çalışma dizinini değiştir
  /auto on|off                     Otomatik onay modu (DİKKAT)
  /model <ad>                      Modeli değiştir
  /web                             Web UI URL'sini göster (token dahil)
  /perms                           Kalıcı izinleri göster
  /perms clear                     'Her zaman izinli' kuralları sil
  /memory                          Hafızadaki notları göster
  /forget <id>                     Bir notu hafızadan sil
  /usage                           Bu oturumun token özeti
  /sessions                        Diskte saklı son oturumları listele
  /resume [<id>]                   Bir oturumu yükle (id verilmezse son)
  /compact                         Mesaj geçmişini şimdi özetle (manuel)

${pc.bold("Çevre değişkenleri:")}  (${pc.dim(".env")} ya da shell)
  OPENAI_API_KEY                   ${cfg?.apiKey ? pc.green("ayarlı") : pc.red("ayarsız")}
  PATRICK_MODEL                    ${cfg?.model ?? "gpt-4o"}
  PATRICK_AUTO_APPROVE             ${cfg?.autoApprove ?? false}
  PATRICK_WEB_PORT                 ${cfg?.webPort ?? 7878}  (0 = kapalı)
  PATRICK_WEB_OPEN                 ${cfg?.webOpenBrowser ?? false}
  PATRICK_LOG_LEVEL                ${cfg?.logLevel ?? "warn"}  (silent|error|warn|info|debug)
  PATRICK_COMPACT_THRESHOLD        ${cfg?.compactThresholdTokens ?? 12000}  (token)
  PATRICK_COMPACT_KEEP_LAST        ${cfg?.compactKeepLastMessages ?? 10}    (mesaj)
`);
}

function printBanner({ model, autoApprove, webUrl }: { model: string; autoApprove: boolean; webUrl?: string }): void {
  console.log();
  console.log(pc.bold(pc.cyan("  patrick")) + pc.dim("  ChatGPT destekli akıllı terminal"));
  console.log(
    pc.dim("  model: ") + pc.white(model) +
    pc.dim("   cwd: ") + pc.white(prettyCwd()) +
    pc.dim("   auto-approve: ") +
    (autoApprove ? pc.red("ON") : pc.green("OFF"))
  );
  if (webUrl) {
    console.log(pc.dim("  web ui: ") + pc.cyan(webUrl));
    console.log(pc.dim("  (URL'deki ?token=… o oturuma özel; her açılışta yenilenir)"));
  }
  console.log(pc.dim("  /help yardım  •  /exit çıkış  •  Ctrl+C iptal/çıkış"));
  console.log();
}

function prettyCwd(): string {
  const cwd = process.cwd();
  const home = os.homedir();
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

function loadHistory(maxLines: number): string[] {
  try { return fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean).slice(-maxLines); }
  catch { return []; }
}
function saveHistoryLine(line: string): void {
  if (!line || line.startsWith("/")) return;
  try { fs.appendFileSync(HISTORY_FILE, line + "\n"); } catch { /* ignore */ }
}

interface MakeAgentOpts {
  cfg: Config;
  bus: EventEmitter;
  confirmer: Confirmer;
  prevAutoApprove?: boolean | null;
}

function makeAgent({ cfg, bus, confirmer, prevAutoApprove = null }: MakeAgentOpts): Agent {
  const auto = prevAutoApprove !== null ? prevAutoApprove : cfg.autoApprove;
  const agentCfg: Config = {
    ...cfg,
    autoApprove: auto,
    model: process.env.PATRICK_MODEL || cfg.model,
  };
  const a = new Agent({ config: agentCfg, confirmer, emitter: bus });
  a.setSystemPrompt(buildSystemPrompt(cfg));
  return a;
}

interface ReplDeps {
  rl: Readline;
  cfg: Config;
  bus: EventEmitter;
  confirmer: Confirmer;
  sessionLogger: SessionLogger;
  webServer: { url: string; close: () => Promise<void> } | null;
  getAgent: () => Agent;
  setAgent: (a: Agent) => void;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);

  if (args.help) { printUsage(cfg); return; }
  if (args.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PATRICK_HOME, "package.json"), "utf8")) as { version: string };
    console.log(`patrick v${pkg.version}`);
    return;
  }

  if (!cfg.apiKey) {
    console.error(pc.red("HATA: OPENAI_API_KEY tanımlı değil."));
    console.error(pc.dim("  ~/.zshrc'ye 'export OPENAI_API_KEY=sk-...' ekleyin"));
    console.error(pc.dim("  veya ~/ai-terminal/.env dosyasını düzenleyin (.env.example'a bakın)."));
    process.exit(1);
  }

  ensureStateDir();

  try {
    const deleted = pruneOldSessions(SESSIONS_BASE_DIR, cfg.sessionKeepDays, log);
    if (deleted > 0) log.info(`${deleted} eski session silindi (${cfg.sessionKeepDays} gün+)`);
  } catch (err) {
    log.warn("session cleanup hatası:", (err as Error).message);
  }

  const sessionLogger = newSessionLogger({
    model: cfg.model,
    persistChunks: cfg.persistChunks,
    log,
  });
  const bus = new EventEmitter();

  const PERSISTABLE_EVENTS = [
    "tool:start", "tool:end",
    "shell:propose", "shell:output",
    "write:propose", "kill_port:propose",
    "assistant:start", "assistant:chunk", "assistant:done", "assistant:text",
    "user:text",
    "agent:usage", "agent:compact",
  ];
  for (const t of PERSISTABLE_EVENTS) {
    bus.on(t, (payload: unknown) => sessionLogger.store.appendEvent(t, payload));
  }

  // Streaming render: stdout chunk-by-chunk
  bus.on("assistant:start", () => { process.stdout.write("\n" + pc.bold(pc.magenta("patrick: "))); });
  bus.on("assistant:chunk", (p: { delta: string }) => { process.stdout.write(p.delta); });
  bus.on("assistant:done", () => { process.stdout.write("\n"); });

  // Compact bilgisi
  bus.on("agent:compact", (p: { count: number; estTokens: number }) => {
    console.log(pc.dim(`\n  (auto-compact: ${p.count} mesaj özetlendi, ~${p.estTokens} token)`));
  });

  let rl: Readline | null = null;
  if (!args.print) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      history: loadHistory(cfg.historySize).reverse(),
      historySize: cfg.historySize,
      removeHistoryDuplicates: true,
    });
  }

  // Web sunucu
  type WebHandle = Awaited<ReturnType<typeof import("./web/server.js").startWebServer>>;
  let webServer: WebHandle | null = null;
  const wantWeb = !args.noWeb && !args.print && cfg.webEnabled;
  if (wantWeb && cfg.webPort > 0) {
    try {
      const { startWebServer } = await import("./web/server.js");
      webServer = await startWebServer({
        host: cfg.webHost,
        port: cfg.webPort,
        getAgent: () => agent,
        bus,
        sessionStore: sessionLogger.store,
      });
    } catch (err) {
      log.warn(`web UI başlatılamadı: ${(err as Error).message}, sadece terminal modu`);
    }
  }

  const confirmer: Confirmer = args.print
    ? createDenyConfirmer({ log })
    : createCompoundConfirmer({
        terminal: createTerminalConfirmer(rl),
        web: webServer,
      });

  let agent: Agent = makeAgent({ cfg, bus, confirmer });

  // --resume / PATRICK_RESUME_ON_START
  if (args.resume || cfg.resumeOnStart) {
    void findLatestSession;
    const all = listSessions(SESSIONS_BASE_DIR);
    const previous = all.find((id) => id !== sessionLogger.id);
    if (previous) {
      const old = loadMessages(SESSIONS_BASE_DIR, previous);
      if (old) {
        const restored = agent.loadSnapshot(old);
        const meta = loadMeta(SESSIONS_BASE_DIR, previous);
        log.info(`session resume: ${previous} (${restored} mesaj, ${meta?.messageCount ?? "?"} orijinal)`);
        console.log(pc.dim(`  (önceki oturum yüklendi: ${previous}, ${restored} mesaj)`));
      } else {
        console.log(pc.yellow(`  (resume: önceki oturumda messages.json yok, devam edilemiyor)`));
      }
    } else {
      console.log(pc.dim("  (resume: önceki oturum yok)"));
    }
  }

  // ---- print modu ----
  if (args.print) {
    if (!args.prompt) {
      console.error(pc.red('HATA: -p ile bir prompt vermelisin: patrick -p "..."'));
      process.exit(2);
    }
    await agent.send(args.prompt);
    try { sessionLogger.saveMessages(agent.messages); } catch { /* ignore */ }
    try { await sessionLogger.close(); } catch { /* ignore */ }
    return;
  }

  // ---- REPL ----
  printBanner({ model: agent.model, autoApprove: agent.autoApprove, webUrl: webServer?.url });

  if (webServer && cfg.webOpenBrowser) {
    exec(`open "${webServer.url}"`, () => { /* fire and forget */ });
  }

  if (args.prompt) {
    console.log(pc.bold(pc.green("you ❯ ")) + args.prompt);
    saveHistoryLine(args.prompt);
    try { await agent.send(args.prompt); }
    catch (err) { console.error(pc.red("\nHata: " + ((err as Error)?.message || err))); }
  }

  await runRepl({
    rl: rl!,
    cfg,
    bus,
    confirmer,
    sessionLogger,
    webServer,
    getAgent: () => agent,
    setAgent: (a: Agent) => { agent = a; },
  });
}

async function runRepl(deps: ReplDeps): Promise<void> {
  const { rl, cfg, bus, confirmer, sessionLogger, webServer, getAgent, setAgent } = deps;

  const refreshPrompt = (): void => {
    rl.setPrompt(`${pc.dim(`(${prettyCwd()})`)} ${pc.bold(pc.green("you ❯"))} `);
    rl.prompt();
  };

  let lastSigint = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    const a = getAgent();
    if (a.isBusy) {
      console.log(pc.yellow("\n  (devam eden iş iptal edildi)"));
      a.cancel();
      return;
    }
    if (rl.line && rl.line.length > 0) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      (rl as unknown as { line: string; cursor: number }).line = "";
      (rl as unknown as { line: string; cursor: number }).cursor = 0;
      refreshPrompt();
      lastSigint = 0;
      return;
    }
    if (now - lastSigint < 1500) { rl.close(); return; }
    lastSigint = now;
    process.stdout.write(pc.dim("\n  (çıkmak için bir kez daha Ctrl+C, ya da /exit)\n"));
    refreshPrompt();
  });

  refreshPrompt();

  rl.on("line", async (raw: string) => {
    const line = raw.trim();
    if (!line) { refreshPrompt(); return; }

    const handled = await handleSlashCommand(line, deps);
    if (handled) { refreshPrompt(); return; }

    saveHistoryLine(line);

    try {
      await getAgent().send(line);
    } catch (err) {
      const m = (err as Error)?.message || String(err);
      console.error(pc.red("\nHata: " + m));
      if (/tool_call_ids did not have response messages/.test(m)) {
        const added = getAgent().repair();
        console.error(pc.yellow(`(mesaj geçmişi otomatik onarıldı, ${added} eksik tool yanıtı tamamlandı — tekrar dene)`));
      }
    }
    refreshPrompt();
  });

  await new Promise<void>((resolve) => {
    rl.on("close", async () => {
      const a = getAgent();
      try { sessionLogger.saveMessages(a.messages); } catch { /* ignore */ }
      try { await sessionLogger.close(); } catch { /* ignore */ }

      if (a.usage.totalTokens > 0) {
        console.log(pc.dim(`\n  oturum kullanımı: ${a.usage.promptTokens} prompt + ${a.usage.completionTokens} completion = ${a.usage.totalTokens} token`));
      }
      console.log(pc.dim("görüşürüz 👋"));
      if (webServer) { try { await webServer.close(); } catch { /* ignore */ } }
      resolve();
      process.exit(0);
    });
  });

  // unused var temizliği için
  void cfg; void bus; void confirmer; void setAgent;
}

async function handleSlashCommand(line: string, deps: ReplDeps): Promise<boolean> {
  const { rl, cfg, bus, confirmer, sessionLogger, webServer, getAgent, setAgent } = deps;

  if (line === "/exit" || line === "/quit") { rl.close(); return true; }
  if (line === "/help") { printUsage(cfg); return true; }
  if (line === "/clear") {
    setAgent(makeAgent({ cfg, bus, confirmer, prevAutoApprove: getAgent().autoApprove }));
    console.log(pc.dim("  (konuşma geçmişi temizlendi)"));
    return true;
  }
  if (line === "/repair") {
    const added = getAgent().repair();
    console.log(pc.dim(`  (mesaj geçmişi onarıldı, ${added} eksik tool yanıtı tamamlandı)`));
    return true;
  }
  if (line.startsWith("/cwd ")) {
    const target = line.slice(5).trim().replace(/^~(?=\/|$)/, os.homedir());
    try { process.chdir(target); console.log(pc.dim("  cwd → " + prettyCwd())); }
    catch (e) { console.log(pc.red("  cwd değişmedi: " + (e as Error).message)); }
    return true;
  }
  if (line.startsWith("/auto ")) {
    const v = line.slice(6).trim().toLowerCase();
    const a = getAgent();
    a.autoApprove = v === "on" || v === "true" || v === "1";
    console.log(pc.dim(`  auto-approve: ${a.autoApprove ? pc.red("ON (dikkat!)") : pc.green("OFF")}`));
    return true;
  }
  if (line.startsWith("/model ")) {
    const m = line.slice(7).trim();
    if (!m) { console.log(pc.red("  Kullanım: /model <ad>")); return true; }
    process.env.PATRICK_MODEL = m;
    setAgent(makeAgent({ cfg, bus, confirmer, prevAutoApprove: getAgent().autoApprove }));
    console.log(pc.dim(`  model: ${m} (geçmiş sıfırlandı)`));
    return true;
  }
  if (line === "/web") {
    if (!webServer) console.log(pc.yellow("  Web UI çalışmıyor. patrick'i --no-web olmadan başlat."));
    else { console.log(pc.dim("  web: ") + pc.cyan(webServer.url)); exec(`open "${webServer.url}"`, () => { /* */ }); }
    return true;
  }
  if (line === "/perms") {
    const p = listPermissions();
    console.log(pc.dim("  her zaman izinli kalıplar:"));
    if (p.allow_patterns.length === 0) console.log(pc.dim("    (yok)"));
    else for (const pat of p.allow_patterns) console.log("    " + pc.green(pat));
    console.log(pc.dim("  her zaman yasak kalıplar:"));
    if (p.deny_patterns.length === 0) console.log(pc.dim("    (yok)"));
    else for (const pat of p.deny_patterns) console.log("    " + pc.red(pat));
    return true;
  }
  if (line === "/perms clear") { clearAllowPatterns(); console.log(pc.dim("  izin kalıpları temizlendi")); return true; }
  if (line === "/memory") {
    const mem = loadMemory();
    if (mem.notes.length === 0) console.log(pc.dim("  (hafıza boş)"));
    else for (const n of mem.notes) console.log(pc.dim("  [" + n.id + "] ") + n.text);
    return true;
  }
  if (line.startsWith("/forget ")) {
    const id = line.slice(8).trim();
    const ok = forgetNote(id);
    console.log(ok ? pc.dim("  silindi") : pc.red("  o id'de not bulunamadı"));
    return true;
  }
  if (line === "/usage") {
    const u = getAgent().usage;
    console.log(pc.dim("  toplam: ") +
      `${u.promptTokens} prompt + ${u.completionTokens} completion = ${u.totalTokens} token`);
    if (u.lastTurn) {
      console.log(pc.dim("  son tur: ") +
        `${u.lastTurn.promptTokens} + ${u.lastTurn.completionTokens} = ${u.lastTurn.totalTokens} token`);
    }
    return true;
  }
  if (line === "/sessions") {
    const ids = listSessions(SESSIONS_BASE_DIR).slice(0, 10);
    if (ids.length === 0) console.log(pc.dim("  (kayıtlı session yok)"));
    else for (const id of ids) {
      const meta = loadMeta(SESSIONS_BASE_DIR, id) || {} as { messageCount?: number; model?: string };
      const live = id === sessionLogger.id ? pc.green(" (şimdiki)") : "";
      console.log(`  ${pc.cyan(id)}${live}  msg=${meta.messageCount ?? "?"} model=${meta.model ?? "?"}`);
    }
    return true;
  }
  if (line === "/resume" || line.startsWith("/resume ")) {
    const wanted = line.length > 7 ? line.slice(8).trim() : "";
    const all = listSessions(SESSIONS_BASE_DIR);
    let target: string | undefined;
    if (wanted) {
      target = all.find((id) => id === wanted || id.startsWith(wanted));
    } else {
      target = all.find((id) => id !== sessionLogger.id);
    }
    if (!target) { console.log(pc.red("  o id'ye uyan session bulunamadı")); return true; }
    const old = loadMessages(SESSIONS_BASE_DIR, target);
    if (!old) { console.log(pc.red("  o session'da messages.json yok")); return true; }
    const restored = getAgent().loadSnapshot(old);
    console.log(pc.dim(`  (yüklendi: ${target}, ${restored} mesaj)`));
    return true;
  }
  if (line === "/compact") {
    const a = getAgent();
    const before = a.estimateTokens();
    const summarized = await a._maybeCompactMessages();
    const after = a.estimateTokens();
    if (summarized > 0) console.log(pc.dim(`  (özetlendi: ${summarized} mesaj, ~${before} → ~${after} token)`));
    else console.log(pc.dim(`  (eşik aşılmadı, ~${before} token)`));
    return true;
  }
  return false;
}

main().catch((err: unknown) => {
  console.error(pc.red("Ölümcül hata: " + ((err as Error)?.message || err)));
  process.exit(1);
});
