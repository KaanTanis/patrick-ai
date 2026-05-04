import pc from "picocolors";
import type { RiskLevel } from "../types.js";

export function riskBadge(level: RiskLevel): string {
  if (level === "safe") return pc.green("SAFE");
  if (level === "approve") return pc.yellow("ONAY");
  return pc.red("YASAK");
}

interface ProposalOpts {
  title: string;
  rows: Array<[string, string]>;
  multilineKey?: string;
}

export function renderProposal({ title, rows, multilineKey }: ProposalOpts): void {
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
