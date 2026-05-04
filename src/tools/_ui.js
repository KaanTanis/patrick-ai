// Tool UI helper'ları — kutular, badge'ler, indent'ler tek yerden.
import pc from "picocolors";

export function riskBadge(level) {
  if (level === "safe") return pc.green("SAFE");
  if (level === "approve") return pc.yellow("ONAY");
  return pc.red("YASAK");
}

/**
 * Konsola "öneri kutusu" basar.
 * rows: [["amaç","..."], ["cmd", "..."], ...]
 */
export function renderProposal({ title, rows, multilineKey }) {
  console.log();
  console.log(pc.dim(`┌─ ${title}`));
  for (const [k, v] of rows) {
    if (k === multilineKey && typeof v === "string" && v.includes("\n")) {
      console.log(pc.dim(`│ ${k.padEnd(7)}:`));
      for (const line of v.split("\n")) console.log(pc.dim("│   ") + line);
    } else {
      console.log(pc.dim(`│ ${k.padEnd(7)}:`), v);
    }
  }
  console.log(pc.dim("└─"));
}
