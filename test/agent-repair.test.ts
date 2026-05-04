import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { ChatMessage } from "../src/types.js";

function makeAgent(): Agent {
  const cfg = loadConfig({ apiKey: "fake-test-key" });
  const a = new Agent({
    config: cfg,
    confirmer: { confirm: async () => "no" },
  });
  a.setSystemPrompt("test");
  return a;
}

test("repair: eksik tool yanıtını sentetik olarak ekler", () => {
  const a = makeAgent();
  a.messages = [
    { role: "system", content: "test" },
    { role: "user", content: "kill ports" },
    { role: "assistant", tool_calls: [
      { id: "call_A", type: "function", function: { name: "kill_port", arguments: "{}" } },
      { id: "call_B", type: "function", function: { name: "kill_port", arguments: "{}" } },
    ] } as ChatMessage,
    { role: "tool", tool_call_id: "call_A", content: "ok" } as ChatMessage,
  ];
  const added = a.repair();
  assert.equal(added, 1);
  assert.equal(a.messages.length, 5);
  const last = a.messages.at(-1) as ChatMessage & { tool_call_id?: string };
  assert.equal(last.tool_call_id, "call_B");
});

test("repair: hiç eksik yoksa dokunmaz", () => {
  const a = makeAgent();
  a.messages = [
    { role: "system", content: "test" },
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [
      { id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } },
    ] } as ChatMessage,
    { role: "tool", tool_call_id: "c1", content: "ok" } as ChatMessage,
  ];
  const before = a.messages.length;
  const added = a.repair();
  assert.equal(added, 0);
  assert.equal(a.messages.length, before);
});

test("reset: system prompt korunur, geri kalan silinir", () => {
  const a = makeAgent();
  a.messages.push({ role: "user", content: "x" }, { role: "assistant", content: "y" });
  a.reset();
  assert.equal(a.messages.length, 1);
  assert.equal(a.messages[0]!.role, "system");
});

test("loadSnapshot: eski mesajları yükler, system prompt'u günceller", () => {
  const a = makeAgent();
  const old: ChatMessage[] = [
    { role: "system", content: "ESKİ SYSTEM" },
    { role: "user", content: "merhaba" },
    { role: "assistant", content: "selam" },
    { role: "user", content: "hava nasıl" },
    { role: "assistant", content: "iyi" },
  ];
  const restored = a.loadSnapshot(old);
  assert.equal(restored, 4);
  assert.equal(a.messages.length, 5);
  assert.equal(a.messages[0]!.role, "system");
  assert.equal((a.messages[0] as { content: string }).content, "test");
  assert.equal((a.messages[1] as { content: string }).content, "merhaba");
  assert.equal((a.messages.at(-1) as { content: string }).content, "iyi");
});

test("loadSnapshot: tool eşleşmesi bozulmaz, repair yapılır", () => {
  const a = makeAgent();
  const old: ChatMessage[] = [
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [
      { id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } },
    ] } as ChatMessage,
    { role: "tool", tool_call_id: "c1", content: "ok" } as ChatMessage,
    { role: "assistant", content: "iyi" },
  ];
  a.loadSnapshot(old);
  for (let i = 0; i < a.messages.length; i++) {
    const m = a.messages[i]!;
    if (m.role !== "assistant") continue;
    const tc = (m as { tool_calls?: Array<{ id: string }> }).tool_calls;
    if (!tc) continue;
    const ids = new Set(tc.map((c) => c.id));
    for (let j = i + 1; j < a.messages.length && a.messages[j]!.role === "tool"; j++) {
      ids.delete((a.messages[j] as { tool_call_id: string }).tool_call_id);
    }
    assert.equal(ids.size, 0, `tool_call ${i} eksik yanıt`);
  }
});
