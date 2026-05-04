import { exec } from "node:child_process";
import { promisify } from "node:util";
import pc from "picocolors";
import { register } from "./registry.js";
import { renderProposal } from "./_ui.js";

const execAsync = promisify(exec);

register({
  name: "list_ports",
  description: "Sistemde dinlenmekte olan TCP portlarını listeler. 'ports' verilirse sadece o portları kontrol eder.",
  parameters: {
    type: "object",
    properties: { ports: { type: "array", items: { type: "integer" } } },
  },
  async handler({ ports }) {
    const filter = (ports && ports.length)
      ? ports.map((p) => `-i :${Number(p)}`).join(" ")
      : "-iTCP -sTCP:LISTEN -P -n";
    try {
      const { stdout } = await execAsync(`lsof ${filter}`, { timeout: 5000 });
      return { ok: true, output: stdout || "(dinleyen port yok)" };
    } catch (err) {
      if (err.code === 1) return { ok: true, output: "(eşleşen dinleyen port yok)" };
      return { ok: false, output: err.message };
    }
  },
});

register({
  name: "find_process",
  description: "ps aux çıktısında bir desene uyan süreçleri bulur.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Aranacak metin (komut adının bir parçası)" } },
    required: ["query"],
  },
  async handler({ query }) {
    if (!query) return { ok: false, output: "query boş olamaz" };
    const safe = String(query).replace(/'/g, "'\\''");
    try {
      const { stdout } = await execAsync(`ps aux | grep -i '${safe}' | grep -v grep`);
      return { ok: true, output: stdout || "(eşleşen süreç yok)" };
    } catch (err) {
      if (err.code === 1) return { ok: true, output: "(eşleşen süreç yok)" };
      return { ok: false, output: err.message };
    }
  },
});

register({
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
  async handler({ ports, force }, ctx) {
    if (!Array.isArray(ports) || ports.length === 0) {
      return { ok: false, output: "ports parametresi gerekli" };
    }

    let info;
    try {
      const args = ports.map((p) => `-i :${Number(p)}`).join(" ");
      const { stdout } = await execAsync(`lsof -P -n ${args}`, { timeout: 5000 });
      info = stdout;
    } catch (err) {
      if (err.code === 1) return { ok: true, output: "Belirtilen portları dinleyen süreç yok." };
      return { ok: false, output: `lsof hatası: ${err.message}` };
    }

    const lines = info.trim().split("\n").slice(1);
    const procs = lines.map((l) => {
      const cols = l.trim().split(/\s+/);
      return { command: cols[0], pid: parseInt(cols[1], 10), user: cols[2], port: cols[8] };
    }).filter((p) => Number.isFinite(p.pid));

    if (procs.length === 0) {
      return { ok: true, output: "Belirtilen portları dinleyen süreç yok." };
    }

    const summary = procs.map((p) => `• ${p.command} (PID ${p.pid}, user ${p.user}, ${p.port})`).join("\n");
    renderProposal({
      title: "kill_port",
      multilineKey: "hedef",
      rows: [
        ["portlar", pc.cyan(ports.join(", "))],
        ["sinyal", force ? "SIGKILL (-9)" : "SIGTERM (-15)"],
        ["hedef", summary],
      ],
    });
    ctx.emitter?.emit?.("kill_port:propose", { ports, force, procs });

    if (!ctx.autoApprove) {
      const decision = await ctx.confirmer.confirm(
        `${procs.length} süreci sonlandırayım mı?`,
        { kind: "kill_port", ports, force, procs }
      );
      if (decision === "no") return { ok: false, output: "Kullanıcı reddetti." };
    }

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
  },
});
