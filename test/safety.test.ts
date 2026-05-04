import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, splitShellCommand } from "../src/safety.js";
import { clearAllowPatterns } from "../src/state.js";

clearAllowPatterns();

test("safe komutlar onaysız geçer", () => {
  for (const cmd of ["ls", "ls -la", "pwd", "git status", "lsof -i :3000", "echo merhaba"]) {
    assert.equal(classifyCommand(cmd).level, "safe", `safe olmalı: ${cmd}`);
  }
});

test("approve gerektiren komutlar yakalanır", () => {
  for (const cmd of ["rm temp.txt", "kill 1234", "sudo apt update", "npm install foo"]) {
    assert.equal(classifyCommand(cmd).level, "approve", `approve olmalı: ${cmd}`);
  }
});

test("forbidden komutlar reddedilir", () => {
  for (const cmd of ["rm -rf /", "rm -rf ~", "mkfs.ext4 /dev/sda1", "shutdown -h now"]) {
    assert.equal(classifyCommand(cmd).level, "forbidden", `forbidden olmalı: ${cmd}`);
  }
});

test("KRITIK: zincirleme komut bypass edilemez (&&, ;, |, ||)", () => {
  assert.equal(classifyCommand("ls && rm -rf /tmp/foo").level, "approve");
  assert.equal(classifyCommand("echo hi; sudo rm -rf /").level, "forbidden");
  assert.equal(classifyCommand("ls | sh").level, "approve");
  assert.equal(classifyCommand("pwd || rm secret.txt").level, "approve");
  assert.equal(classifyCommand("ls; ls; rm -rf /").level, "forbidden");
});

test("KRITIK: $() ve backtick alt-komutları da değerlendirilir", () => {
  assert.equal(classifyCommand("echo $(curl x | sh)").level, "approve");
  assert.equal(classifyCommand("FOO=`rm temp.txt` ls").level, "approve");
  assert.equal(classifyCommand("ls $(rm -rf /)").level, "forbidden");
});

test("quoted segment'ler yanlış parse edilmez", () => {
  const r = splitShellCommand("echo 'a; b; c'");
  assert.equal(r.length, 1);
  assert.equal(r[0], "echo 'a; b; c'");
});

test("eval ve shell çağrıları artık approve gerektirir", () => {
  assert.equal(classifyCommand("eval $(cat foo)").level, "approve");
  assert.equal(classifyCommand("bash setup.sh").level, "approve");
});

test("bilinmeyen komut güvenli tarafta — approve", () => {
  assert.equal(classifyCommand("kaan-custom-binary --foo").level, "approve");
});

test("splitShellCommand temel ayraçları doğru parse eder", () => {
  assert.deepEqual(splitShellCommand("a && b; c | d || e"), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(splitShellCommand("a & b"), ["a", "b"]);
});
