import { exec, type ChildProcess } from "node:child_process";
import pc from "picocolors";
import { register } from "./registry.js";
import { classifyCommand } from "../safety.js";
import { suggestPermissionPattern, rememberAllowPattern, allowOnceForSession } from "../state.js";
import { renderProposal, riskBadge } from "./_ui.js";
import type { ToolContext, ToolResult } from "../types.js";

interface RunShellArgs {
  command: string;
  purpose: string;
  cwd?: string;
  timeout_sec?: number;
}

register<RunShellArgs>({
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
      timeout_sec: { type: "number", description: "Maksimum çalışma süresi (sn)" },
    },
    required: ["command", "purpose"],
  },
  handler: runShell,
});

async function runShell({ command, purpose, cwd, timeout_sec }: RunShellArgs, ctx: ToolContext): Promise<ToolResult> {
  const cls = classifyCommand(command);

  renderProposal({
    title: "komut çalıştırılacak",
    rows: [
      ["amaç", purpose || "(belirtilmedi)"],
      ["cmd", pc.cyan(command)],
      ...(cwd ? [["cwd", cwd] as [string, string]] : []),
      ["risk", `${riskBadge(cls.level)}${cls.reason ? pc.dim(" — " + cls.reason) : ""}`],
    ],
  });

  ctx.emitter?.emit("shell:propose", { command, purpose, cwd, risk: cls.level, reason: cls.reason, segments: cls.segments });

  if (cls.level === "forbidden") {
    return { ok: false, output: `KOMUT REDDEDİLDİ (yasaklı): ${cls.reason}` };
  }

  if (cls.level === "approve" && !ctx.autoApprove) {
    const suggestedPattern = suggestPermissionPattern(command);
    const decision = await ctx.confirmer.confirm("Bu komutu çalıştırmama izin veriyor musun?", {
      kind: "shell",
      command, purpose, cwd, risk: cls.level, reason: cls.reason ?? undefined,
      suggestedPattern,
    });
    if (decision === "no") return { ok: false, output: "Kullanıcı reddetti." };
    // ConfirmerDecision'da "session" yok artık; "yes" tek kullanımlık varsayılır.
    if (decision === "always") rememberAllowPattern(suggestedPattern);
    void allowOnceForSession; // unused tutmak için - ileride session decision dönerse kullanılır
  }

  const timeoutMs = (timeout_sec || ctx.config.toolTimeoutSec) * 1000;

  return new Promise<ToolResult>((resolve) => {
    const child: ChildProcess = exec(command, {
      cwd: cwd || process.cwd(),
      timeout: timeoutMs,
      maxBuffer: ctx.config.shellMaxOutputBytes,
      shell: process.env.SHELL || "/bin/zsh",
      signal: ctx.signal,
    }, (err, stdout, stderr) => {
      if (err) {
        const e = err as Error & { code?: number; signal?: string; killed?: boolean; stdout?: string; stderr?: string };
        const msg = e.killed
          ? `Komut iptal edildi (timeout veya kullanıcı kesintisi): ${e.signal || ""}`
          : `Komut hata verdi (exit ${e.code ?? "?"}):\n${stdout || ""}\n${stderr || ""}\n${e.message}`;
        console.log(pc.red(indent(msg, "  ")));
        ctx.emitter?.emit("shell:output", { command, ok: false, output: msg });
        resolve({ ok: false, output: msg });
        return;
      }
      const out = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      if (out.trim()) console.log(pc.dim(indent(out, "  ")));
      ctx.emitter?.emit("shell:output", { command, ok: true, output: out });
      resolve({ ok: true, output: out || "(çıktı yok)" });
    });

    if (ctx.onChild) ctx.onChild(child);
  });
}

function indent(text: string, prefix: string): string {
  return String(text).split("\n").map((l) => prefix + l).join("\n");
}
