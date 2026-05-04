// Agent.repair() davranışı: bozuk mesaj dizisini geçerli hale getirir mi?
//
// Çalıştır: node --test test/agent-repair.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";

function makeAgent() {
  const cfg = loadConfig({ apiKey: "fake-test-key" });
  const a = new Agent({
    config: cfg,
    confirmer: { confirm: async () => "no" },
    emitter: { emit() {} },
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
      { id: "call_A", function: { name: "kill_port", arguments: "{}" } },
      { id: "call_B", function: { name: "kill_port", arguments: "{}" } },
    ]},
    { role: "tool", tool_call_id: "call_A", content: "ok" },
  ];
  const added = a.repair();
  assert.equal(added, 1);
  assert.equal(a.messages.length, 5);
  assert.equal(a.messages.at(-1).tool_call_id, "call_B");
});

test("repair: hiç eksik yoksa dokunmaz", () => {
  const a = makeAgent();
  a.messages = [
    { role: "system", content: "test" },
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [{ id: "c1", function: { name: "list_dir", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "ok" },
  ];
  const before = a.messages.length;
  const added = a.repair();
  assert.equal(added, 0);
  assert.equal(a.messages.length, before);
});

test("repair: birden fazla bozuk assistant mesajını sırayla onarır", () => {
  const a = makeAgent();
  a.messages = [
    { role: "system", content: "test" },
    { role: "user", content: "x" },
    { role: "assistant", tool_calls: [{ id: "a1", function: { name: "list_dir", arguments: "{}" } }] },
    // a1'in yanıtı yok
    { role: "user", content: "y" },
    { role: "assistant", tool_calls: [{ id: "b1", function: { name: "list_dir", arguments: "{}" } }] },
    // b1'in de yanıtı yok
  ];
  const added = a.repair();
  assert.equal(added, 2);
  // Validasyon: her assistant{tool_calls}'tan sonra tool yanıtları gelmeli
  for (let i = 0; i < a.messages.length; i++) {
    const m = a.messages[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    const ids = new Set(m.tool_calls.map((c) => c.id));
    for (let j = i + 1; j < a.messages.length && a.messages[j].role === "tool"; j++) {
      ids.delete(a.messages[j].tool_call_id);
    }
    assert.equal(ids.size, 0, `step ${i} hâlâ eksik: ${[...ids]}`);
  }
});

test("reset: system prompt korunur, geri kalan silinir", () => {
  const a = makeAgent();
  a.messages.push({ role: "user", content: "x" }, { role: "assistant", content: "y" });
  a.reset();
  assert.equal(a.messages.length, 1);
  assert.equal(a.messages[0].role, "system");
});
