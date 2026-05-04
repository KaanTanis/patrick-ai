// Tool registry: yeni tool eklemek istediğinde sadece register() çağırırsın.
// Schema + handler tek dosyada, dispatcher otomatik dispatch eder.

import type { Tool, ToolContext, ToolResult, OpenAIToolSchema } from "../types.js";

const _tools: Map<string, Tool> = new Map();

export function register<TArgs = Record<string, unknown>>(tool: Tool<TArgs>): void {
  if (!tool?.name || typeof tool.handler !== "function") {
    throw new Error("register: name + handler zorunlu");
  }
  if (_tools.has(tool.name)) {
    throw new Error(`register: '${tool.name}' zaten kayıtlı`);
  }
  _tools.set(tool.name, tool as unknown as Tool);
}

export function listTools(): Tool[] {
  return [..._tools.values()];
}

export function getOpenAISchemas(): OpenAIToolSchema[] {
  return [..._tools.values()].map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Tek bir tool çağrısını dispatch eder.
 * Ctx'i tüm hata durumlarında bile garanti olarak emit eder ve { ok, output } döndürür.
 */
export async function dispatchTool(name: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = _tools.get(name);
  if (!tool) return { ok: false, output: `Bilinmeyen tool: ${name}` };

  ctx.emitter?.emit("tool:start", { name, args });
  let result: ToolResult;
  try {
    result = await tool.handler((args ?? {}) as Record<string, unknown>, ctx);
    if (!result || typeof result !== "object") {
      result = { ok: true, output: String(result ?? "") };
    }
  } catch (err) {
    ctx.log?.error?.(`tool '${name}' istisna fırlattı`, (err as Error)?.message);
    result = { ok: false, output: `İç hata (${name}): ${(err as Error)?.message ?? err}` };
  }
  ctx.emitter?.emit("tool:end", { name, ok: result.ok, output: trim(result.output, 4000) });
  return result;
}

function trim(s: string | undefined | null, n: number): string {
  const str = String(s ?? "");
  return str.length <= n ? str : str.slice(0, n) + `\n[...${str.length - n} karakter kesildi...]`;
}
