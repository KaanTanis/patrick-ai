import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SessionStore, listSessions, loadMeta, loadEvents, loadMessages,
  pruneOldSessions, findLatestSession,
} from "../src/session-store.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "patrick-test-"));
after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } });

test("create + appendEvent + getEventsSince", async () => {
  const s = SessionStore.create({ baseDir: TMP, model: "gpt-test" });
  assert.ok(s.id);
  assert.ok(fs.existsSync(s.dir));

  const c1 = s.appendEvent("user:text", { text: "merhaba" });
  const c2 = s.appendEvent("assistant:text", { text: "selam" });
  assert.equal(c1, 1);
  assert.equal(c2, 2);
  assert.equal(s.eventCount, 2);

  const all = s.getEventsSince(0);
  assert.equal(all.length, 2);
  assert.equal(all[0]!.type, "user:text");
  assert.equal(all[1]!.type, "assistant:text");

  const tail = s.getEventsSince(1);
  assert.equal(tail.length, 1);
  assert.equal(tail[0]!.type, "assistant:text");

  await s.close();
});

test("persistChunks=false → assistant:chunk persist edilmez", async () => {
  const s = SessionStore.create({ baseDir: TMP, model: "gpt-test", persistChunks: false });
  assert.equal(s.appendEvent("assistant:chunk", { delta: "Mer" }), null);
  assert.equal(s.appendEvent("assistant:chunk", { delta: "haba" }), null);
  assert.equal(s.appendEvent("user:text", { text: "selam" }), 1);
  assert.equal(s.eventCount, 1);
  await s.close();
});

test("persistChunks=true → assistant:chunk persist edilir", async () => {
  const s = SessionStore.create({ baseDir: TMP, model: "gpt-test", persistChunks: true });
  assert.equal(s.appendEvent("assistant:chunk", { delta: "Mer" }), 1);
  assert.equal(s.appendEvent("assistant:chunk", { delta: "haba" }), 2);
  assert.equal(s.eventCount, 2);
  await s.close();
});

test("assistant:start ve assistant:done her zaman skip edilir", async () => {
  const s = SessionStore.create({ baseDir: TMP, model: "gpt-test", persistChunks: true });
  assert.equal(s.appendEvent("assistant:start", {}), null);
  assert.equal(s.appendEvent("assistant:done", { text: "ok" }), null);
  assert.equal(s.eventCount, 0);
  await s.close();
});

test("close + diskten geri yükleme", async () => {
  const s = SessionStore.create({ baseDir: TMP, model: "gpt-test" });
  s.appendEvent("user:text", { text: "test" });
  s.saveMessages([{ role: "user", content: "test" }]);
  await s.close();

  const meta = loadMeta(TMP, s.id);
  assert.ok(meta);
  assert.equal(meta!.id, s.id);
  assert.equal(meta!.model, "gpt-test");
  assert.ok(meta!.ended);

  const events = loadEvents(TMP, s.id);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "user:text");

  const msgs = loadMessages(TMP, s.id);
  assert.deepEqual(msgs, [{ role: "user", content: "test" }]);
});

test("listSessions en yeni başta sıralar", async () => {
  const sub = fs.mkdtempSync(path.join(TMP, "list-"));
  await new Promise(r => setTimeout(r, 5));
  const s1 = SessionStore.create({ baseDir: sub, model: "x" }); await s1.close();
  await new Promise(r => setTimeout(r, 5));
  const s2 = SessionStore.create({ baseDir: sub, model: "x" }); await s2.close();
  const ids = listSessions(sub);
  assert.equal(ids.length, 2);
  assert.equal(ids[0], s2.id, "en yeni başta olmalı");
  assert.equal(findLatestSession(sub), s2.id);
});

test("pruneOldSessions: eski olanları siler, yenileri korur", async () => {
  const sub = fs.mkdtempSync(path.join(TMP, "prune-"));
  const old = SessionStore.create({ baseDir: sub, model: "x" }); await old.close();
  const fresh = SessionStore.create({ baseDir: sub, model: "x" }); await fresh.close();

  const oldMeta = loadMeta(sub, old.id);
  assert.ok(oldMeta);
  oldMeta!.started = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(sub, old.id, "meta.json"), JSON.stringify(oldMeta));

  const deleted = pruneOldSessions(sub, 30);
  assert.equal(deleted, 1, "1 eski session silinmeli");
  const remaining = listSessions(sub);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0], fresh.id);
});

test("appendEvent kapalı session'a no-op", async () => {
  const s = SessionStore.create({ baseDir: TMP, model: "x" });
  await s.close();
  assert.equal(s.appendEvent("user:text", { text: "post-close" }), null);
});
