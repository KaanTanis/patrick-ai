// Güvenlik politikası: hangi komutlar serbest, hangileri onay ister, hangileri yasak.
//
// KRİTİK TASARIM: Bir komut string'i çoklu segmenti içerebilir:
//   "ls && rm -rf /tmp"   →  [ "ls", "rm -rf /tmp" ]
// İlk segmentin SAFE olması yeterli değildir; en yüksek risk seviyesi kazanır.

import { isAlwaysAllowed, isAlwaysDenied } from "./state.js";
import type { Classification, RiskLevel, SegmentClassification } from "./types.js";

const SAFE_PREFIXES: readonly string[] = [
  "ls", "pwd", "cd", "echo", "cat", "head", "tail", "wc", "stat",
  "which", "whoami", "hostname", "uname", "uptime", "date",
  "ps", "top", "htop", "df", "du", "free", "lsof",
  "env", "printenv",
  "grep", "rg", "find", "fd", "tree",
  "node", "python", "python3", "pip", "pip3",
  "git status", "git log", "git diff", "git branch", "git show", "git remote",
  "npm list", "npm ls", "npm outdated", "npm view",
  "brew list", "brew info",
  "curl", "ping", "dig", "nslookup", "traceroute",
];

const APPROVAL_PATTERNS: readonly RegExp[] = [
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b\s+-r/,
  /\bchmod\b/, /\bchown\b/,
  /\bkill(all)?\b/, /\bpkill\b/,
  />\s*\/?[^\s|&;]+/,
  /\bsudo\b/,
  /\bbrew\s+(install|uninstall|reinstall|upgrade)/,
  /\bnpm\s+(install|uninstall|update|publish|run)/,
  /\bpip3?\s+(install|uninstall)/,
  /\bgit\s+(push|reset|rebase|checkout|merge|commit|add)/,
  /\bdocker\b/, /\bkubectl\b/,
  /\bmkdir\b/, /\btouch\b/, /\btee\b/,
  /\bopen\b/,
  /\b(sh|bash|zsh|fish)\b/,
  /\beval\b/,
  /\bexport\b/,
  /\bsource\b/, /^\.\s/,
];

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf?\s+\/(?!\w)/,
  /\brm\s+-rf?\s+~\s*$/,
  /\brm\s+-rf?\s+\$HOME\s*$/,
  /:\(\)\s*\{.*\|\s*:.*&\s*\}\s*;:/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=.*of=\/dev\/[sh]d/,
  />\s*\/dev\/[sh]d/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
];

/**
 * Bir komut string'ini shell separator'larıyla segmentlerine böler.
 * Quote-aware: tek tırnak, çift tırnak ve escape karakterlerini gözetir.
 */
export function splitShellCommand(cmd: string): string[] {
  const segs: string[] = [];
  let i = 0;
  let cur = "";
  const subs: string[] = [];

  const flush = () => {
    const t = cur.trim();
    if (t) segs.push(t);
    cur = "";
  };

  while (i < cmd.length) {
    const c = cmd[i];
    const next = cmd[i + 1];

    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[i + 1];
      i += 2;
      continue;
    }

    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) { cur += cmd.slice(i); break; }
      cur += cmd.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    if (c === '"') {
      cur += c; i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length) { cur += (cmd[i] ?? "") + (cmd[i + 1] ?? ""); i += 2; continue; }
        if (cmd[i] === "$" && cmd[i + 1] === "(") {
          const start = i;
          let depth = 1; i += 2;
          while (i < cmd.length && depth > 0) {
            if (cmd[i] === "(") depth++;
            else if (cmd[i] === ")") depth--;
            i++;
          }
          subs.push(cmd.slice(start + 2, i - 1));
          cur += cmd.slice(start, i);
          continue;
        }
        if (cmd[i] === "`") {
          const start = i;
          i++;
          while (i < cmd.length && cmd[i] !== "`") i++;
          subs.push(cmd.slice(start + 1, i));
          cur += cmd.slice(start, i + 1);
          i++;
          continue;
        }
        cur += cmd[i] ?? ""; i++;
      }
      if (i < cmd.length) { cur += cmd[i]; i++; }
      continue;
    }

    if (c === "$" && next === "(") {
      const start = i;
      let depth = 1; i += 2;
      while (i < cmd.length && depth > 0) {
        if (cmd[i] === "(") depth++;
        else if (cmd[i] === ")") depth--;
        i++;
      }
      subs.push(cmd.slice(start + 2, i - 1));
      cur += cmd.slice(start, i);
      continue;
    }

    if (c === "`") {
      const start = i; i++;
      while (i < cmd.length && cmd[i] !== "`") {
        if (cmd[i] === "\\" && i + 1 < cmd.length) { i += 2; continue; }
        i++;
      }
      subs.push(cmd.slice(start + 1, i));
      cur += cmd.slice(start, i + 1);
      i++;
      continue;
    }

    if (c === ";") { flush(); i++; continue; }
    if (c === "&" && next === "&") { flush(); i += 2; continue; }
    if (c === "|" && next === "|") { flush(); i += 2; continue; }
    if (c === "|") { flush(); i++; continue; }
    if (c === "&" && next !== "&") { flush(); i++; continue; }

    cur += c;
    i++;
  }
  flush();

  for (const sub of subs) {
    for (const s of splitShellCommand(sub)) segs.push(s);
  }
  return segs;
}

const RANK: Record<RiskLevel, number> = { safe: 0, approve: 1, forbidden: 2 };

function classifySegment(seg: string): SegmentClassification {
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(seg)) return { segment: seg, level: "forbidden", reason: `Yasaklı kalıp: ${pat}` };
  }
  if (isAlwaysDenied(seg)) {
    return { segment: seg, level: "forbidden", reason: "Kullanıcı kalıcı olarak yasaklamış" };
  }
  if (isAlwaysAllowed(seg)) {
    return { segment: seg, level: "safe", reason: "Kullanıcı tarafından kalıcı izinli" };
  }
  for (const pat of APPROVAL_PATTERNS) {
    if (pat.test(seg)) return { segment: seg, level: "approve", reason: `Riskli kalıp: ${pat}` };
  }
  for (const prefix of SAFE_PREFIXES) {
    if (seg === prefix || seg.startsWith(prefix + " ")) {
      return { segment: seg, level: "safe" };
    }
  }
  return { segment: seg, level: "approve", reason: "Bilinmeyen komut — emniyet için onay isteniyor" };
}

export function classifyCommand(cmd: string): Classification {
  const segs = splitShellCommand(cmd);
  if (segs.length === 0) return { level: "safe", segments: [] };

  let worst: Classification = { level: "safe" };
  const annotated: SegmentClassification[] = [];
  for (const seg of segs) {
    const r = classifySegment(seg);
    annotated.push(r);
    if (RANK[r.level] > RANK[worst.level]) {
      worst = { level: r.level, reason: `[${seg}] ${r.reason || ""}`.trim() };
    }
  }
  return { ...worst, segments: annotated };
}

const FORBIDDEN_WRITE_PATHS: readonly string[] = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/System", "/Library",
];

export interface WritePathClassification {
  level: "approve" | "forbidden";
  reason?: string;
}

export function classifyWritePath(absPath: string): WritePathClassification {
  for (const p of FORBIDDEN_WRITE_PATHS) {
    if (absPath === p || absPath.startsWith(p + "/")) {
      return { level: "forbidden", reason: `Sistem dizini: ${p}` };
    }
  }
  return { level: "approve" };
}
