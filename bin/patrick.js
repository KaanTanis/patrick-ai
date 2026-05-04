#!/usr/bin/env node
// Patrick entry point.
//
// Çalışma sırası:
//   1) dist/cli.js varsa → onu çalıştır (hızlı, derlenmiş)
//   2) Yoksa src/cli.ts'i tsx ile çalıştır (geliştirme modu)
//   3) tsx da yoksa kullanıcıya `npm run build` öner

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const distEntry = join(root, "dist", "cli.js");
const srcEntry = join(root, "src", "cli.ts");

if (existsSync(distEntry)) {
  await import(distEntry);
} else if (existsSync(srcEntry)) {
  // tsx ile dev mode
  const tsxBin = join(root, "node_modules", ".bin", "tsx");
  if (!existsSync(tsxBin)) {
    console.error("Patrick: derlenmiş dist/ yok ve tsx kurulmamış.");
    console.error("  cd " + root + " && npm run build");
    process.exit(1);
  }
  const child = spawn(tsxBin, [srcEntry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  console.error("Patrick: hiçbir entry point bulunamadı.");
  process.exit(1);
}
