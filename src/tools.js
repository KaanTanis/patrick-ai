import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { classifyCommand, classifyWritePath } from "./safety.js";
import {
  rememberAllowPattern,
  allowOnceForSession,
  suggestPermissionPattern,
  rememberNote,
  recallNotes,
  forgetNote,
  loadMemory,
} from "./state.js";

const execAsync = promisify(exec);

// ---- pluggable hooks (CLI ile web UI'ın aynı agent'ı paylaşması için) ----
// Confirmer: { confirm(question, context) -> Promise<"yes"|"no"|"always"> }
// Emitter:   { emit(event, payload) }  — opsiyonel, web UI canlı gösterim için
let _confirmer = null;
let _emitter = { emit: () => {} };
export function setConfirmer(c) { _confirmer = c; }
export function setEmitter(e) { _emitter = e || _emitter; }
function emit(event, payload) { try { _emitter.emit(event, payload); } catch {} }

// ---- OpenAI tool şemaları ----
export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "run_shell",
      description:
        "Kullanıcının macOS makinesinde bir shell (zsh) komutu çalıştırır. " +
        "Her zaman 'purpose' alanını doldur. " +
        "Yıkıcı komutlar için sistem kullanıcıdan onay alır; sen sormadan çağır.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Çalıştırılacak tam shell komutu" },
          purpose: { type: "string", description: "Bu komutu neden çalıştırıyorsun, tek cümle" },
          cwd: { type: "string", description: "İsteğe bağlı çalışma dizini (mutlak yol)" },
          timeout_sec: { type: "number", description: "Maksimum çalışma süresi (sn). Varsayılan 30." },
        },
        required: ["command", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "kill_port",
      description: "Bir veya birden çok TCP portunu dinleyen süreçleri bulur ve sonlandırır. Onay sorulur.",
      parameters: {
        type: "object",
        properties: {
          ports: { type: "array", items: { type: "integer" }, description: "Hedef portlar, örn [3000, 3001]" },
          force: { type: "boolean", description: "SIGKILL kullan (varsayılan SIGTERM)" },
        },
        required: ["ports"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_ports",
      description: "Sistemde dinlenmekte olan TCP portlarını listeler. 'ports' verilirse sadece o portları kontrol eder.",
      parameters: {
        type: "object",
        properties: {
          ports: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_process",
      description: "ps aux çıktısında bir desene uyan süreçleri bulur.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Aranacak metin (komut adının bir parçası)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Bir dosyanın içeriğini okur. Büyük dosyalar için 'max_bytes' kullan.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          max_bytes: { type: "number", description: "Varsayılan 200000" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Bir dosyaya içerik yazar. Var olanın üstüne yazar. " +
        "Sistem dizinlerine yazılamaz; her yazma işlemi onay ister.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          purpose: { type: "string" },
        },
        required: ["path", "content", "purpose"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "Bir dizinin içeriğini listeler.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Varsayılan: cwd" } },
      },
    },
  },
  // ---- Memory tool'ları ----
  {
    type: "function",
    function: {
      name: "memory_remember",
      description:
        "Kullanıcı hakkında ya da makinesi hakkında kalıcı bir not kaydeder. " +
        "Örn: tercih ettiği proje yolu, sık kullanılan servis adları, kişisel kısaltmalar. " +
        "Sadece kullanıcı 'bunu hatırla' dediğinde ya da açıkça yararlı olacak bir gerçek öğrenildiğinde kullan. " +
        "Şifre, anahtar, kişisel veri KAYDETME.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Hatırlanacak gerçek, tek cümle." },
          tags: { type: "array", items: { type: "string" }, description: "İsteğe bağlı etiketler" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_recall",
      description: "Hafızadan ilgili notları getirir. 'query' boşsa son notları döndürür.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Varsayılan 10" },
        },
      },
    },
  },
];

// ---- Tool dispatcher ----
export async function runTool(call, opts = {}) {
  const { name, args } = call;
  emit("tool:start", { name, args });
  let result;
  try {
    switch (name) {
      case "run_shell":      result = await runShell(args, opts); break;
      case "kill_port":      result = await killPort(args, opts); break;
      case "list_ports":     result = await listPorts(args); break;
      case "find_process":   result = await findProcess(args); break;
      case "read_file":      result = await readFileTool(args); break;
      case "write_file":     result = await writeFileTool(args, opts); break;
      case "list_dir":       result = await listDirTool(args); break;
      case "memory_remember": result = memoryRememberTool(args); break;
      case "memory_recall":  result = memoryRecallTool(args); break;
      default: result = { ok: false, output: `Bilinmeyen tool: ${name}` };
    }
  } catch (err) {
    result = { ok: false, output: `İç hata (${name}): ${err?.message || err}` };
  }
  emit("tool:end", { name, ok: result.ok, output: truncate(result.output, 4000) });
  return result;
}

// ---- ortak onay yardımcısı ----
async function getDecision(message, context) {
  if (!_confirmer) return "no"; // confirmer set edilmemişse güvenli reddet
  return _confirmer.confirm(message, context);
}

// ---- LOW-LEVEL: shell, fs ----
async function runShell({ command, purpose, cwd, timeout_sec = 30 }, { autoApprove }) {
  const cls = classifyCommand(command);

  console.log();
  console.log(pc.dim("┌─ komut çalıştırılacak"));
  console.log(pc.dim("│ amaç :"), pc.white(purpose || "(belirtilmedi)"));
  console.log(pc.dim("│ cmd  :"), pc.cyan(command));
  if (cwd) console.log(pc.dim("│ cwd  :"), pc.white(cwd));
  console.log(pc.dim("│ risk :"), riskBadge(cls.level), cls.reason ? pc.dim("— " + cls.reason) : "");
  console.log(pc.dim("└─"));

  emit("shell:propose", { command, purpose, cwd, risk: cls.level, reason: cls.reason });

  if (cls.level === "forbidden") {
    return { ok: false, output: `KOMUT REDDEDİLDİ (yasaklı): ${cls.reason}` };
  }

  if (cls.level === "approve" && !autoApprove) {
    const suggestedPattern = suggestPermissionPattern(command);
    const decision = await getDecision("Bu komutu çalıştırmama izin veriyor musun?", {
      kind: "shell",
      command, purpose, cwd, risk: cls.level, reason: cls.reason,
      suggestedPattern,
    });
    if (decision === "no") return { ok: false, output: "Kullanıcı reddetti." };
    if (decision === "session") allowOnceForSession(command);
    if (decision === "always") rememberAllowPattern(suggestedPattern);
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || process.cwd(),
      timeout: timeout_sec * 1000,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.env.SHELL || "/bin/zsh",
    });
    const out = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
    if (out.trim()) console.log(pc.dim(indent(out, "  ")));
    emit("shell:output", { command, ok: true, output: out });
    return { ok: true, output: out || "(çıktı yok)" };
  } catch (err) {
    const out = `Komut hata verdi (exit ${err.code ?? "?"}):\n${err.stdout || ""}\n${err.stderr || ""}\n${err.message}`;
    console.log(pc.red(indent(out, "  ")));
    emit("shell:output", { command, ok: false, output: out });
    return { ok: false, output: out };
  }
}

async function readFileTool({ path: p, max_bytes = 200_000 }) {
  try {
    const abs = path.resolve(p);
    const data = await fs.readFile(abs);
    const sliced = data.slice(0, max_bytes).toString("utf8");
    const truncated = data.length > max_bytes ? `\n[...${data.length - max_bytes} bayt kesildi...]` : "";
    console.log(pc.dim(`  ↳ okundu: ${abs} (${data.length} bayt)`));
    return { ok: true, output: sliced + truncated };
  } catch (err) {
    return { ok: false, output: `Okuma hatası: ${err.message}` };
  }
}

async function writeFileTool({ path: p, content, purpose }, { autoApprove }) {
  const abs = path.resolve(p);
  const cls = classifyWritePath(abs);

  console.log();
  console.log(pc.dim("┌─ dosya yazılacak"));
  console.log(pc.dim("│ amaç :"), pc.white(purpose || "(belirtilmedi)"));
  console.log(pc.dim("│ path :"), pc.cyan(abs));
  console.log(pc.dim("│ boyut:"), pc.white(`${Buffer.byteLength(content)} bayt`));
  console.log(pc.dim("└─"));

  emit("write:propose", { path: abs, purpose, size: Buffer.byteLength(content) });

  if (cls.level === "forbidden") return { ok: false, output: `Yazma REDDEDİLDİ: ${cls.reason}` };

  if (!autoApprove) {
    const decision = await getDecision("Bu dosyayı yazmama izin veriyor musun?", {
      kind: "write", path: abs, purpose, size: Buffer.byteLength(content),
    });
    if (decision === "no") return { ok: false, output: "Kullanıcı reddetti." };
  }

  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return { ok: true, output: `Yazıldı: ${abs}` };
  } catch (err) {
    return { ok: false, output: `Yazma hatası: ${err.message}` };
  }
}

async function listDirTool({ path: p }) {
  try {
    const abs = path.resolve(p || process.cwd());
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
    return { ok: true, output: `${abs}:\n${lines.join("\n")}` };
  } catch (err) {
    return { ok: false, output: `Listeleme hatası: ${err.message}` };
  }
}

// ---- HIGH-LEVEL: kill_port, list_ports, find_process ----
async function listPorts({ ports }) {
  const filter = (ports && ports.length)
    ? ports.map((p) => `-i :${p}`).join(" ")
    : "-iTCP -sTCP:LISTEN -P -n";
  try {
    const { stdout } = await execAsync(`lsof ${filter}`, { timeout: 5000 });
    return { ok: true, output: stdout || "(dinleyen port yok)" };
  } catch (err) {
    if (err.code === 1) return { ok: true, output: "(eşleşen dinleyen port yok)" };
    return { ok: false, output: err.message };
  }
}

async function findProcess({ query }) {
  if (!query) return { ok: false, output: "query boş olamaz" };
  try {
    const safe = query.replace(/'/g, "'\\''");
    const { stdout } = await execAsync(`ps aux | grep -i '${safe}' | grep -v grep`);
    return { ok: true, output: stdout || "(eşleşen süreç yok)" };
  } catch (err) {
    if (err.code === 1) return { ok: true, output: "(eşleşen süreç yok)" };
    return { ok: false, output: err.message };
  }
}

async function killPort({ ports, force }, { autoApprove }) {
  if (!Array.isArray(ports) || ports.length === 0) {
    return { ok: false, output: "ports parametresi gerekli" };
  }

  // 1) Süreçleri bul
  let info;
  try {
    const args = ports.map((p) => `-i :${Number(p)}`).join(" ");
    const { stdout } = await execAsync(`lsof -P -n ${args}`, { timeout: 5000 });
    info = stdout;
  } catch (err) {
    if (err.code === 1) return { ok: true, output: "Belirtilen portları dinleyen süreç yok." };
    return { ok: false, output: `lsof hatası: ${err.message}` };
  }

  // 2) PID ve komut adlarını çıkar
  const lines = info.trim().split("\n").slice(1);
  const procs = lines.map((l) => {
    const cols = l.trim().split(/\s+/);
    return { command: cols[0], pid: parseInt(cols[1], 10), user: cols[2], port: cols[8] };
  }).filter((p) => Number.isFinite(p.pid));

  if (procs.length === 0) {
    return { ok: true, output: "Belirtilen portları dinleyen süreç yok." };
  }

  const summary = procs.map((p) => `  • ${p.command} (PID ${p.pid}, user ${p.user}, ${p.port})`).join("\n");
  console.log();
  console.log(pc.dim("┌─ kill_port"));
  console.log(pc.dim("│ portlar:"), pc.cyan(ports.join(", ")));
  console.log(pc.dim("│ sinyal :"), pc.white(force ? "SIGKILL (-9)" : "SIGTERM (-15)"));
  console.log(pc.dim("│ hedef  :\n"), summary);
  console.log(pc.dim("└─"));

  emit("kill_port:propose", { ports, force, procs });

  if (!autoApprove) {
    const decision = await getDecision(
      `${procs.length} süreci sonlandırayım mı?`,
      { kind: "kill_port", ports, force, procs }
    );
    if (decision === "no") return { ok: false, output: "Kullanıcı reddetti." };
  }

  // 3) Öldür
  const sig = force ? "-9" : "-15";
  const results = [];
  for (const p of procs) {
    try {
      await execAsync(`kill ${sig} ${p.pid}`, { timeout: 3000 });
      results.push(`✓ ${p.command} (PID ${p.pid}) → kill ${sig}`);
    } catch (err) {
      results.push(`✗ ${p.command} (PID ${p.pid}) → ${err.message}`);
    }
  }
  return { ok: true, output: results.join("\n") };
}

// ---- MEMORY tool'ları ----
function memoryRememberTool({ text, tags = [] }) {
  if (!text || !text.trim()) return { ok: false, output: "text boş olamaz" };
  const note = rememberNote(text, tags);
  console.log(pc.dim(`  ↳ memory: not eklendi (${note.id})`));
  return { ok: true, output: `Not kaydedildi (id=${note.id}): ${note.text}` };
}
function memoryRecallTool({ query = "", limit = 10 }) {
  const notes = recallNotes(query, limit);
  if (notes.length === 0) return { ok: true, output: "(eşleşen not yok)" };
  const lines = notes.map((n) => `[${n.id}] ${n.text}` + (n.tags?.length ? ` (#${n.tags.join(", #")})` : ""));
  return { ok: true, output: lines.join("\n") };
}

// ---- yardımcılar ----
function riskBadge(level) {
  if (level === "safe") return pc.green("SAFE");
  if (level === "approve") return pc.yellow("ONAY");
  return pc.red("YASAK");
}
function indent(text, prefix) {
  return text.split("\n").map((l) => prefix + l).join("\n");
}
function truncate(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n) + `\n[...${s.length - n} karakter kesildi...]`;
}

// ---- terminal-tabanlı varsayılan confirmer ----
import readline from "node:readline";
export function createTerminalConfirmer() {
  return {
    async confirm(message, context) {
      const sug = context?.suggestedPattern;
      const opts = sug
        ? "[y/N/a=her zaman izin]"
        : "[y/N]";
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => {
        rl.question(pc.yellow(`${message} ${opts} `), (answer) => {
          rl.close();
          const a = answer.trim().toLowerCase();
          if (a === "a" || a === "always") resolve("always");
          else if (/^y/.test(a)) resolve("yes");
          else resolve("no");
        });
      });
    },
  };
}
