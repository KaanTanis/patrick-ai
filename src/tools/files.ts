import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { register } from "./registry.js";
import { classifyWritePath } from "../safety.js";
import { renderProposal } from "./_ui.js";
import type { ToolContext, ToolResult } from "../types.js";

interface ReadFileArgs { path: string; max_bytes?: number; }
interface WriteFileArgs { path: string; content: string; purpose: string; }
interface ListDirArgs { path?: string; }

register<ReadFileArgs>({
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
  async handler({ path: p, max_bytes = 200_000 }): Promise<ToolResult> {
    try {
      const abs = path.resolve(p);
      const data = await fs.readFile(abs);
      const sliced = data.slice(0, max_bytes).toString("utf8");
      const truncated = data.length > max_bytes ? `\n[...${data.length - max_bytes} bayt kesildi...]` : "";
      console.log(pc.dim(`  ↳ okundu: ${abs} (${data.length} bayt)`));
      return { ok: true, output: sliced + truncated };
    } catch (err) {
      return { ok: false, output: `Okuma hatası: ${(err as Error).message}` };
    }
  },
});

register<WriteFileArgs>({
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
  async handler({ path: p, content, purpose }, ctx: ToolContext): Promise<ToolResult> {
    const abs = path.resolve(p);
    const cls = classifyWritePath(abs);
    const size = Buffer.byteLength(content);

    renderProposal({
      title: "dosya yazılacak",
      rows: [
        ["amaç", purpose || "(belirtilmedi)"],
        ["path", pc.cyan(abs)],
        ["boyut", `${size} bayt`],
      ],
    });
    ctx.emitter?.emit("write:propose", { path: abs, purpose, size });

    if (cls.level === "forbidden") return { ok: false, output: `Yazma REDDEDİLDİ: ${cls.reason}` };

    if (!ctx.autoApprove) {
      const decision = await ctx.confirmer.confirm("Bu dosyayı yazmama izin veriyor musun?", {
        kind: "write", path: abs, purpose, size,
      });
      if (decision === "no") return { ok: false, output: "Kullanıcı reddetti." };
    }

    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return { ok: true, output: `Yazıldı: ${abs}` };
    } catch (err) {
      return { ok: false, output: `Yazma hatası: ${(err as Error).message}` };
    }
  },
});

register<ListDirArgs>({
  name: "list_dir",
  description: "Bir dizinin içeriğini listeler.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Varsayılan: cwd" } },
  },
  async handler({ path: p }): Promise<ToolResult> {
    try {
      const abs = path.resolve(p || process.cwd());
      const entries = await fs.readdir(abs, { withFileTypes: true });
      const lines = entries.map((e) => `${e.isDirectory() ? "d" : "-"} ${e.name}`);
      return { ok: true, output: `${abs}:\n${lines.join("\n")}` };
    } catch (err) {
      return { ok: false, output: `Listeleme hatası: ${(err as Error).message}` };
    }
  },
});
