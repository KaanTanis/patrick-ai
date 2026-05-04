// Güvenlik politikası: hangi komutlar serbest, hangileri onay ister, hangileri kesinlikle yasak.
// Politika basit ve şeffaf tutulmuştur; her zaman kullanıcı görebilir/değiştirebilir.
//
// KRİTİK TASARIM: Bir komut string'i çoklu segmenti içerebilir:
//   "ls && rm -rf /tmp"   →  [ "ls", "rm -rf /tmp" ]
//   "echo hi | sh"        →  [ "echo hi", "sh" ]
//   "x=$(curl ...)"       →  [ "x=$(curl ...)", "curl ..." ]
// İlk segmentin SAFE olması yeterli değildir; en yüksek risk seviyesi kazanır.
// `splitShellCommand` shell separator'larını parse edip segmentleri çıkarır.

import { isAlwaysAllowed, isAlwaysDenied } from "./state.js";

// Onaysız çalışan, "salt-okunur / zararsız" komut prefiksleri.
// Eşleşme: segmentin ilk tokenı bu listede olmalı (veya `git <alt-komut>` gibi 2 token).
const SAFE_PREFIXES = [
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

// Onay isteyen riskli kalıplar (regex).
const APPROVAL_PATTERNS = [
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
  /\b(sh|bash|zsh|fish)\b/,           // herhangi bir shell çağrısı (curl|sh dahil)
  /\beval\b/,                          // eval — daima onay
  /\bexport\b/,                        // env değiştirme — daima onay
  /\bsource\b/, /^\.\s/,               // source / dot-source
];

// Hiçbir koşulda çalıştırılmayacak felaket kalıpları.
const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf?\s+\/(?!\w)/,            // rm -rf / ya da rm -rf /<boşluk>
  /\brm\s+-rf?\s+~\s*$/,
  /\brm\s+-rf?\s+\$HOME\s*$/,
  /:\(\)\s*\{.*\|\s*:.*&\s*\}\s*;:/,    // fork bomb
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+if=.*of=\/dev\/[sh]d/,
  />\s*\/dev\/[sh]d/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
];

/**
 * Bir komut string'ini shell separator'larıyla segmentlerine böler.
 * Quote-aware: tek tırnak, çift tırnak ve escape karakterlerini gözetir.
 * `$( … )` ve `` ` … ` `` içerikleri ayrı segment olarak çıkar.
 *
 * @param {string} cmd
 * @returns {string[]} segmentler (boşlukları trimlenmiş, boşlar atılmış)
 */
export function splitShellCommand(cmd) {
  const segs = [];
  let i = 0;
  let depthParen = 0;       // $( ... )
  let depthBacktick = 0;    // ` ... `
  let cur = "";
  const subs = [];          // dolaylı çağrılan alt-komutlar

  const flush = () => {
    const t = cur.trim();
    if (t) segs.push(t);
    cur = "";
  };

  while (i < cmd.length) {
    const c = cmd[i];
    const next = cmd[i + 1];

    // Backslash-escape — bir sonraki karakteri olduğu gibi kabul et
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[i + 1];
      i += 2;
      continue;
    }

    // Tek tırnaklı blok: içinde hiçbir şey yorumlanmaz
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) { cur += cmd.slice(i); break; }
      cur += cmd.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Çift tırnaklı blok: içinde $() ve `` hâlâ yorumlanır → karakter karakter ilerle
    if (c === '"') {
      cur += c; i++;
      while (i < cmd.length && cmd[i] !== '"') {
        if (cmd[i] === "\\" && i + 1 < cmd.length) { cur += cmd[i] + cmd[i + 1]; i += 2; continue; }
        if (cmd[i] === "$" && cmd[i + 1] === "(") {
          // Alt-komut: parantezi bul, içeriği subs'a koy
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
        cur += cmd[i]; i++;
      }
      if (i < cmd.length) { cur += cmd[i]; i++; }
      continue;
    }

    // $( ... )  alt-komut
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

    // backtick alt-komut
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

    // Separator'lar: ; && || |
    if (c === ";") { flush(); i++; continue; }
    if (c === "&" && next === "&") { flush(); i += 2; continue; }
    if (c === "|" && next === "|") { flush(); i += 2; continue; }
    if (c === "|") { flush(); i++; continue; }
    if (c === "&" && next !== "&") { flush(); i++; continue; } // arka plan

    cur += c;
    i++;
  }
  flush();

  // Alt-komutları da segmentlere ekle (recursive parse)
  for (const sub of subs) {
    for (const s of splitShellCommand(sub)) segs.push(s);
  }
  return segs;
}

const RANK = { safe: 0, approve: 1, forbidden: 2 };

/**
 * Tek bir segmentin (zincirleme olmayan) risk sınıfını döndürür.
 */
function classifySegment(seg) {
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(seg)) return { level: "forbidden", reason: `Yasaklı kalıp: ${pat}` };
  }
  if (isAlwaysDenied(seg)) {
    return { level: "forbidden", reason: "Kullanıcı kalıcı olarak yasaklamış" };
  }
  if (isAlwaysAllowed(seg)) {
    return { level: "safe", reason: "Kullanıcı tarafından kalıcı izinli" };
  }
  for (const pat of APPROVAL_PATTERNS) {
    if (pat.test(seg)) return { level: "approve", reason: `Riskli kalıp: ${pat}` };
  }
  for (const prefix of SAFE_PREFIXES) {
    if (seg === prefix || seg.startsWith(prefix + " ")) {
      return { level: "safe" };
    }
  }
  return { level: "approve", reason: "Bilinmeyen komut — emniyet için onay isteniyor" };
}

/**
 * Tüm komutu (zincirleme dahil) sınıflandırır. En yüksek risk seviyesi kazanır.
 * Reason, riski tetikleyen segmenti ve kuralı söyler.
 *
 * @returns {{level: "safe"|"approve"|"forbidden", reason?: string, segments?: Array}}
 */
export function classifyCommand(cmd) {
  const segs = splitShellCommand(cmd);
  if (segs.length === 0) return { level: "safe", segments: [] };

  let worst = { level: "safe" };
  const annotated = [];
  for (const seg of segs) {
    const r = classifySegment(seg);
    annotated.push({ segment: seg, ...r });
    if (RANK[r.level] > RANK[worst.level]) {
      worst = { level: r.level, reason: `[${seg}] ${r.reason || ""}`.trim() };
    }
  }
  return { ...worst, segments: annotated };
}

// Dosya yazma işlemleri için yol kontrolü.
const FORBIDDEN_WRITE_PATHS = [
  "/etc", "/usr", "/bin", "/sbin", "/var", "/System", "/Library",
];

export function classifyWritePath(absPath) {
  for (const p of FORBIDDEN_WRITE_PATHS) {
    if (absPath === p || absPath.startsWith(p + "/")) {
      return { level: "forbidden", reason: `Sistem dizini: ${p}` };
    }
  }
  return { level: "approve" };
}
