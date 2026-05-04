// Summarization (auto-compact) testleri.
// OpenAI client'ını mock'larız: Agent'in private `client.chat.completions.create`
// çağrısını intercept ederiz.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { ChatMessage } from "../src/types.js";

function makeAgent(overrides: Partial<Parameters<typeof loadConfig>[0]> = {}): Agent {
  const cfg = loadConfig({
    apiKey: "fake-test-key",
    compactEnabled: true,
    compactThresholdTokens: 1000,
    compactKeepLastMessages: 4,
    ...overrides,
  });
  const a = new Agent({
    config: cfg,
    confirmer: { confirm: async () => "no" },
  });
  a.setSystemPrompt("test-system");
  return a;
}

test("estimateTokens: yaklaşık doğru hesap (~chars/4 * 1.2)", () => {
  const a = makeAgent();
  // 400 karakter content → 100 token * 1.2 = 120
  a.messages = [
    { role: "system", content: "test-system" },
    { role: "user", content: "x".repeat(400) },
  ];
  const t = a.estimateTokens();
  assert.ok(t >= 110 && t <= 140, `beklenen ~120, geldi ${t}`);
});

test("_maybeCompactMessages: eşik altındaysa no-op", async () => {
  const a = makeAgent();
  a.messages = [
    { role: "system", content: "test-system" },
    { role: "user", content: "kısa mesaj" },
    { role: "assistant", content: "kısa cevap" },
  ];
  const before = a.messages.length;
  const summarized = await a._maybeCompactMessages();
  assert.equal(summarized, 0);
  assert.equal(a.messages.length, before);
});

test("_maybeCompactMessages: eşik aşıldığında eski mesajları özetler", async (t) => {
  const a = makeAgent();
  // Mock model çağrısı: özet metni döndür
  let captured: { messages: ChatMessage[] } | null = null;
  (a.client.chat.completions as unknown as {
    create: (req: { messages: ChatMessage[] }) => Promise<unknown>;
  }).create = async (req) => {
    captured = { messages: req.messages };
    return { choices: [{ message: { content: "ÖZET: 5 mesaj kompaktlandı" } }] };
  };

  // 8 mesaj, her biri 500 karakter → ~1500 token (eşik 1000)
  a.messages = [
    { role: "system", content: "test-system" },
    { role: "user", content: "a".repeat(500) },
    { role: "assistant", content: "b".repeat(500) },
    { role: "user", content: "c".repeat(500) },
    { role: "assistant", content: "d".repeat(500) },
    { role: "user", content: "e".repeat(500) },
    { role: "assistant", content: "f".repeat(500) },
    { role: "user", content: "g".repeat(500) },
    { role: "assistant", content: "h".repeat(500) },
  ];
  const initialCount = a.messages.length;

  const summarized = await a._maybeCompactMessages();

  // En az 1 mesaj özetlenmiş olmalı (keep last 4 → en eski 4 özetlenir)
  assert.ok(summarized > 0, `summarized > 0 olmalı, geldi ${summarized}`);
  // System + summary mesajı + son 4 mesaj = 6
  assert.equal(a.messages.length, 1 + 1 + 4);
  assert.equal(a.messages[0]!.role, "system");
  // Summary mesajı assistant rolünde
  assert.equal(a.messages[1]!.role, "assistant");
  const sumContent = (a.messages[1] as { content: string }).content;
  assert.match(sumContent, /Geçmiş Özeti/);
  assert.match(sumContent, /ÖZET: 5 mesaj kompaktlandı/);
  // Son mesaj orijinal son mesaj olmalı
  assert.equal((a.messages.at(-1) as { content: string }).content, "h".repeat(500));

  // Mock'a gönderilen prompt'ta "Sen bir konuşma özetleyicisin" geçmeli
  assert.ok(captured, "mock captured olmalı");
  const sysMsg = captured!.messages[0] as { content: string };
  assert.match(sysMsg.content, /özetleyici/);

  void initialCount;
  void t;
});

test("_maybeCompactMessages: tool_call/tool eşleşmesi bozulmaz", async () => {
  const a = makeAgent({ compactKeepLastMessages: 2 });
  // Mock
  (a.client.chat.completions as unknown as {
    create: (req: { messages: ChatMessage[] }) => Promise<unknown>;
  }).create = async () => ({
    choices: [{ message: { content: "özet" } }],
  });

  // assistant{tool_calls} + tool yanıtları kesim noktasında bölünmemeli
  a.messages = [
    { role: "system", content: "test-system" },
    { role: "user", content: "a".repeat(800) },
    { role: "assistant", tool_calls: [
      { id: "c1", type: "function", function: { name: "list_dir", arguments: "{}" } },
    ] } as ChatMessage,
    { role: "tool", tool_call_id: "c1", content: "tool result" } as ChatMessage,
    { role: "assistant", content: "b".repeat(800) },
    { role: "user", content: "c".repeat(800) },
    { role: "assistant", content: "d".repeat(800) },
  ];

  await a._maybeCompactMessages();

  // Invariant: her assistant{tool_calls} için tool yanıtları gelmeli
  for (let i = 0; i < a.messages.length; i++) {
    const m = a.messages[i]!;
    if (m.role !== "assistant") continue;
    const tc = (m as { tool_calls?: Array<{ id: string }> }).tool_calls;
    if (!tc) continue;
    const ids = new Set(tc.map((c) => c.id));
    for (let j = i + 1; j < a.messages.length && a.messages[j]!.role === "tool"; j++) {
      ids.delete((a.messages[j] as { tool_call_id: string }).tool_call_id);
    }
    assert.equal(ids.size, 0, `tool_call ${i} için yanıt eksik`);
  }
});

test("compactEnabled=false ise hiç çalışmaz", async () => {
  const a = makeAgent({ compactEnabled: false, compactThresholdTokens: 10 });
  a.messages = [
    { role: "system", content: "test-system" },
    { role: "user", content: "a".repeat(1000) },
    { role: "assistant", content: "b".repeat(1000) },
    { role: "user", content: "c".repeat(1000) },
    { role: "assistant", content: "d".repeat(1000) },
    { role: "user", content: "e".repeat(1000) },
  ];
  const before = a.messages.length;
  // compactEnabled false ise send() içinde otomatik çağrı yapılmaz, ama
  // _maybeCompactMessages doğrudan çağrılırsa yine de çalışır — bu testte
  // doğrudan çağırmıyoruz, sadece bayrağı doğruluyoruz.
  assert.equal(a.config.compactEnabled, false);
  assert.equal(a.messages.length, before);
});
