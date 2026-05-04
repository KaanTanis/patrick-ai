import "dotenv/config";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { EventEmitter } from "node:events";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import pc from "picocolors";
import { Agent } from "./agent.js";
import { buildSystemPrompt } from "./prompt.js";
import { createTerminalConfirmer } from "./tools.js";
import { ensureStateDir, newSessionLogger, listPermissions, clearAllowPatterns, loadMemory, forgetNote } from "./state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PATRICK_HOME = path.join(__dirname, "..");

// Repo kökündeki .env'yi de yükle (binary nereden çağrılırsa çağrılsın çalışmalı)
const repoEnv = path.join(PATRICK_HOME, ".env");
if (fs.existsSync(repoEnv)) {
  for (const line of fs.readFileSync(repoEnv, "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const HISTORY_FILE = path.join(os.homedir(), ".patrick-history");
const HISTORY_MAX = 500;

// ---------- argv ----------
function parseArgs(argv) {
  const out = { print: false, help: false, version: false, noWeb: false, prompt: "" };
  const tokens = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-p" || a === "--print") out.print = true;
    else if (a === "-h" || a === "--help") out.help = true;
    else if (a === "-v" || a === "--version") out.version = true;
    else if (a === "--no-web") out.noWeb = true;
    else tokens.push(a);
  }
  out.prompt = tokens.join(" ").trim();
  return out;
}

function printUsage() {
  console.log(`
${pc.bold("patrick")} — ChatGPT destekli, hafızalı, web UI'lı terminal asistanı

${pc.bold("Kullanım:")}
  patrick                          REPL aç (web UI da otomatik başlar)
  patrick "soru / komut"           Soruyu çalıştır, sonra REPL'de kal
  patrick -p "soru"                Tek seferlik (script modu): cevap ver, çık
  patrick --no-web                 Web UI'ı başlatma (sadece terminal)
  patrick --help                   Bu mesaj

${pc.bold("REPL slash komutları:")}
  /exit, /quit, Ctrl+D             Çıkış
  /clear                           Konuşma geçmişini sıfırla
  /help                            Yardım
  /cwd <yol>                       Çalışma dizinini değiştir
  /auto on|off                     Otomatik onay modu (DİKKAT)
  /model <ad>                      Modeli değiştir (örn. gpt-4o-mini)
  /web                             Web UI URL'sini göster, tarayıcıda aç
  /perms                           Kalıcı izinleri göster
  /perms clear                     Tüm 'her zaman izinli' kuralları temizle
  /memory                          Hafızadaki notları göster
  /forget <id>                     Bir notu hafızadan sil

${pc.bold("Çevre değişkenleri:")}
  OPENAI_API_KEY                   ${process.env.OPENAI_API_KEY ? pc.green("ayarlı") : pc.red("ayarsız")}
  PATRICK_MODEL                    ${process.env.PATRICK_MODEL || "gpt-4o"} (varsayılan)
  PATRICK_AUTO_APPROVE             ${process.env.PATRICK_AUTO_APPROVE || "false"}
  PATRICK_WEB_PORT                 ${process.env.PATRICK_WEB_PORT || "7878"}  (0 = kapalı)
  PATRICK_WEB_OPEN                 ${process.env.PATRICK_WEB_OPEN || "false"}
`);
}

function printBanner({ model, autoApprove, webUrl }) {
  console.log();
  console.log(pc.bold(pc.cyan("  patrick")) + pc.dim("  ChatGPT destekli akıllı terminal"));
  console.log(
    pc.dim("  model: ") + pc.white(model) +
    pc.dim("   cwd: ") + pc.white(prettyCwd()) +
    pc.dim("   auto-approve: ") +
    (autoApprove ? pc.red("ON") : pc.green("OFF"))
  );
  if (webUrl) {
    console.log(pc.dim("  web ui: ") + pc.cyan(webUrl) + pc.dim("  (terminalle senkron)"));
  }
  console.log(pc.dim("  /help yardım  •  /exit çıkış  •  Ctrl+C iptal/çıkış"));
  console.log();
}

function prettyCwd() {
  const cwd = process.cwd();
  const home = os.homedir();
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

function loadHistory() {
  try { return fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean).slice(-HISTORY_MAX); }
  catch { return []; }
}
function saveHistoryLine(line) {
  if (!line || line.startsWith("/")) return;
  try { fs.appendFileSync(HISTORY_FILE, line + "\n"); } catch {}
}

// ---------- compound confirmer (terminal + web, ilk cevap kazanır) ----------
function makeCompoundConfirmer({ terminalConfirmer, webServer }) {
  return {
    async confirm(message, context) {
      // Web UI yoksa düz terminal davranışı
      if (!webServer) return terminalConfirmer.confirm(message, context);

      // Hem terminal hem web'e sor; ilk yanıt kazanır.
      const webHandle = webServer.registerPendingApproval({ ...context, message });
      const termPromise = terminalConfirmer.confirm(message, context).then((d) => ({ from: "terminal", d }));
      const webPromise = webHandle.promise.then((d) => ({ from: "web", d }));

      const winner = await Promise.race([termPromise, webPromise]);
      // Diğerini iptal et: web tarafı için sadece pending'den çıkar; terminal stdin sorusunu maalesef
      // tamamen iptal edemiyoruz, kullanıcı boş Enter'la geçebilir. Ama sonuç zaten döndü.
      if (winner.from === "terminal") webHandle.cancel();
      return winner.d === "always" ? "always" : winner.d === "yes" ? "yes" : "no";
    },
  };
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { printUsage(); return; }
  if (args.version) {
    const pkg = JSON.parse(fs.readFileSync(path.join(PATRICK_HOME, "package.json"), "utf8"));
    console.log(`patrick v${pkg.version}`);
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error(pc.red("HATA: OPENAI_API_KEY tanımlı değil."));
    console.error(pc.dim("  ~/.zshrc'ye 'export OPENAI_API_KEY=sk-...' ekleyin"));
    console.error(pc.dim("  veya ~/ai-terminal/.env dosyasını düzenleyin (.env.example'a bakın)."));
    process.exit(1);
  }

  ensureStateDir();
  const sessionLogger = newSessionLogger();
  const bus = new EventEmitter();
  const terminalConfirmer = createTerminalConfirmer();

  // ---- web sunucusu (varsayılan açık, --no-web veya port=0 ile kapalı) ----
  let webServer = null;
  const wantWeb = !args.noWeb && !args.print;
  const webPort = parseInt(process.env.PATRICK_WEB_PORT || "7878", 10);
  if (wantWeb && webPort > 0) {
    try {
      const { startWebServer } = await import("./web/server.js");
      webServer = await startWebServer({
        port: webPort,
        getAgent: () => agent,
        bus,
      });
    } catch (err) {
      console.error(pc.yellow(`(web UI başlatılamadı: ${err.message}, sadece terminal modu)`));
    }
  }

  const confirmer = makeCompoundConfirmer({ terminalConfirmer, webServer });

  let agent = makeAgent({ apiKey, bus, confirmer, sessionLogger });

  // ---- print modu ----
  if (args.print) {
    if (!args.prompt) {
      console.error(pc.red('HATA: -p ile bir prompt vermelisin: patrick -p "..."'));
      process.exit(2);
    }
    await agent.send(args.prompt);
    return;
  }

  // ---- REPL ----
  printBanner({ model: agent.model, autoApprove: agent.autoApprove, webUrl: webServer?.url });

  if (webServer && /^true$/i.test(process.env.PATRICK_WEB_OPEN || "")) {
    exec(`open ${webServer.url}`, () => {});
  }

  if (args.prompt) {
    console.log(pc.bold(pc.green("you ❯ ")) + args.prompt);
    saveHistoryLine(args.prompt);
    bus.emit("user:text", { text: args.prompt });
    try { await agent.send(args.prompt); }
    catch (err) { console.error(pc.red("\nHata: " + (err?.message || err))); }
  }

  await runRepl({
    getAgent: () => agent,
    setAgent: (a) => (agent = a),
    apiKey,
    bus,
    confirmer,
    sessionLogger,
    webServer,
  });
}

function makeAgent({ apiKey, bus, confirmer, sessionLogger, prevAutoApprove = null }) {
  const auto = prevAutoApprove !== null
    ? prevAutoApprove
    : /^true$/i.test(process.env.PATRICK_AUTO_APPROVE || "");
  return new Agent({
    apiKey,
    model: process.env.PATRICK_MODEL || "gpt-4o",
    systemPrompt: buildSystemPrompt(),
    autoApprove: auto,
    emitter: bus,
    confirmer,
    sessionLogger,
  });
}

async function runRepl({ getAgent, setAgent, apiKey, bus, confirmer, sessionLogger, webServer }) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: loadHistory().reverse(),
    historySize: HISTORY_MAX,
    removeHistoryDuplicates: true,
  });

  const refreshPrompt = () => {
    const cwd = pc.dim(`(${prettyCwd()})`);
    rl.setPrompt(`${cwd} ${pc.bold(pc.green("you ❯"))} `);
    rl.prompt();
  };

  let lastSigint = 0;
  rl.on("SIGINT", () => {
    const now = Date.now();
    if (rl.line && rl.line.length > 0) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      rl.line = ""; rl.cursor = 0;
      refreshPrompt();
      lastSigint = 0;
      return;
    }
    if (now - lastSigint < 1500) return rl.close();
    lastSigint = now;
    process.stdout.write(pc.dim("\n  (çıkmak için bir kez daha Ctrl+C, ya da /exit)\n"));
    refreshPrompt();
  });

  refreshPrompt();

  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) return refreshPrompt();

    if (line === "/exit" || line === "/quit") return rl.close();
    if (line === "/help") { printUsage(); return refreshPrompt(); }
    if (line === "/clear") {
      setAgent(makeAgent({ apiKey, bus, confirmer, sessionLogger, prevAutoApprove: getAgent().autoApprove }));
      console.log(pc.dim("  (konuşma geçmişi temizlendi)"));
      return refreshPrompt();
    }
    if (line.startsWith("/cwd ")) {
      const target = line.slice(5).trim().replace(/^~(?=\/|$)/, os.homedir());
      try { process.chdir(target); console.log(pc.dim("  cwd → " + prettyCwd())); }
      catch (e) { console.log(pc.red("  cwd değişmedi: " + e.message)); }
      return refreshPrompt();
    }
    if (line.startsWith("/auto ")) {
      const v = line.slice(6).trim().toLowerCase();
      const a = getAgent();
      a.autoApprove = v === "on" || v === "true" || v === "1";
      console.log(pc.dim(`  auto-approve: ${a.autoApprove ? pc.red("ON (dikkat!)") : pc.green("OFF")}`));
      return refreshPrompt();
    }
    if (line.startsWith("/model ")) {
      const m = line.slice(7).trim();
      if (!m) { console.log(pc.red("  Kullanım: /model <ad>")); return refreshPrompt(); }
      process.env.PATRICK_MODEL = m;
      setAgent(makeAgent({ apiKey, bus, confirmer, sessionLogger, prevAutoApprove: getAgent().autoApprove }));
      console.log(pc.dim(`  model: ${m} (geçmiş sıfırlandı)`));
      return refreshPrompt();
    }
    if (line === "/web") {
      if (!webServer) console.log(pc.yellow("  Web UI çalışmıyor. patrick'i --no-web olmadan başlat."));
      else { console.log(pc.dim("  web: ") + pc.cyan(webServer.url)); exec(`open ${webServer.url}`, () => {}); }
      return refreshPrompt();
    }
    if (line === "/perms") {
      const p = listPermissions();
      console.log(pc.dim("  her zaman izinli kalıplar:"));
      if (p.allow_patterns.length === 0) console.log(pc.dim("    (yok)"));
      else for (const pat of p.allow_patterns) console.log("    " + pc.green(pat));
      console.log(pc.dim("  her zaman yasak kalıplar:"));
      if (p.deny_patterns.length === 0) console.log(pc.dim("    (yok)"));
      else for (const pat of p.deny_patterns) console.log("    " + pc.red(pat));
      return refreshPrompt();
    }
    if (line === "/perms clear") {
      clearAllowPatterns();
      console.log(pc.dim("  izin kalıpları temizlendi"));
      return refreshPrompt();
    }
    if (line === "/memory") {
      const mem = loadMemory();
      if (mem.notes.length === 0) console.log(pc.dim("  (hafıza boş)"));
      else for (const n of mem.notes) console.log(pc.dim("  [" + n.id + "] ") + n.text);
      return refreshPrompt();
    }
    if (line.startsWith("/forget ")) {
      const id = line.slice(8).trim();
      const ok = forgetNote(id);
      console.log(ok ? pc.dim("  silindi") : pc.red("  o id'de not bulunamadı"));
      return refreshPrompt();
    }

    saveHistoryLine(line);
    bus.emit("user:text", { text: line });

    rl.pause();
    try { await getAgent().send(line); }
    catch (err) { console.error(pc.red("\nHata: " + (err?.message || err))); }
    rl.resume();
    refreshPrompt();
  });

  await new Promise((resolve) => {
    rl.on("close", async () => {
      console.log(pc.dim("\ngörüşürüz 👋"));
      if (webServer) { try { await webServer.close(); } catch {} }
      resolve();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error(pc.red("Ölümcül hata: " + (err?.message || err)));
  process.exit(1);
});
