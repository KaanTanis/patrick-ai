// Tool registry: yeni tool eklemek istediğinde sadece register() çağırırsın.
// Schema + handler tek dosyada, dispatcher otomatik dispatch eder.
//
// Bir tool şu şekildedir:
//   {
//     name: string,
//     description: string,
//     parameters: { ... JSON Schema ... },
//     handler: async (args, ctx) => { ok, output }
//   }
//
// `ctx` yapısı:
//   { confirmer, emitter, autoApprove, signal, config, log }

const _tools = new Map();

export function register(tool) {
  if (!tool?.name || typeof tool.handler !== "function") {
    throw new Error("register: name + handler zorunlu");
  }
  if (_tools.has(tool.name)) {
    throw new Error(`register: '${tool.name}' zaten kayıtlı`);
  }
  _tools.set(tool.name, tool);
}

export function listTools() {
  return [..._tools.values()];
}

export function getOpenAISchemas() {
  return [..._tools.values()].map((t) => ({
    type: "function",
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
export async function dispatchTool(name, args, ctx) {
  const tool = _tools.get(name);
  if (!tool) return { ok: false, output: `Bilinmeyen tool: ${name}` };

  ctx.emitter?.emit?.("tool:start", { name, args });
  let result;
  try {
    result = await tool.handler(args ?? {}, ctx);
    if (!result || typeof result !== "object") {
      result = { ok: true, output: String(result ?? "") };
    }
  } catch (err) {
    ctx.log?.error?.(`tool '${name}' istisna fırlattı`, err?.message);
    result = { ok: false, output: `İç hata (${name}): ${err?.message || err}` };
  }
  ctx.emitter?.emit?.("tool:end", { name, ok: result.ok, output: trim(result.output, 4000) });
  return result;
}

function trim(s, n) {
  s = String(s ?? "");
  return s.length <= n ? s : s.slice(0, n) + `\n[...${s.length - n} karakter kesildi...]`;
}
