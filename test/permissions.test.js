// Kalıcı izin pattern üretici testleri.
// Çalıştır: node --test test/permissions.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { suggestPermissionPattern } from "../src/state.js";

test("suggestPermissionPattern: sayıları joker yapar", () => {
  assert.equal(suggestPermissionPattern("kill 1234"), "^kill \\d+$");
});

test("suggestPermissionPattern: 2+ tokenlı komutlarda kuyruğu serbest bırakır", () => {
  assert.equal(suggestPermissionPattern("npm install lodash"), "^npm install\\b.*");
});

test("suggestPermissionPattern: regex meta-karakterlerini escape eder", () => {
  const p = suggestPermissionPattern("rm temp.txt");
  // Beklenen: ^rm temp\.txt$
  assert.match(p, /^\^rm temp\\\.txt\$$/);
});

test("suggestPermissionPattern: kısa komutta tüm string'i bağlar", () => {
  assert.equal(suggestPermissionPattern("date"), "^date$");
});
