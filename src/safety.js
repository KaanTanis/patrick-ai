// Güvenlik politikası: hangi komutlar serbest, hangileri onay ister, hangileri kesinlikle yasak.
// Politika basit ve şeffaf tutulmuştur; her zaman kullanıcı görebilir/değiştirebilir.

import { isAlwaysAllowed, isAlwaysDenied } from "./state.js";

// Onaysız çalışan, "salt-okunur / zararsız" komut prefiksleri.
// Eşleşme: komutun ilk tokenı bu listede olmalı (veya `git <alt-komut>` gibi 2 token).
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

// Onay isteyen riskli kalıplar (regex). Buradaki bir eşleşme "danışılmadan çalışmaz".
const APPROVAL_PATTERNS = [
  /\brm\b/,              // dosya silme
  /\bmv\b/,              // taşıma
  /\bcp\b\s+-r/,         // recursive copy
  /\bchmod\b/, /\bchown\b/,
  /\bkill(all)?\b/, /\bpkill\b/,
  />\s*\/?[^\s|&;]+/,    // dosyaya yönlendirme  (>, >>)
  /\bsudo\b/,
  /\bbrew\s+(install|uninstall|reinstall|upgrade)/,
  /\bnpm\s+(install|uninstall|update|publish|run)/,
  /\bpip3?\s+(install|uninstall)/,
  /\bgit\s+(push|reset|rebase|checkout|merge|commit|add)/,
  /\bdocker\b/, /\bkubectl\b/,
  /\bmkdir\b/, /\btouch\b/, /\btee\b/,
  /\bopen\b/,            // macOS uygulama açar
  /\bcurl\s+[^|]*\|\s*(sh|bash|zsh)/, // curl | sh — her zaman tehlikeli
];

// Hiçbir koşulda çalıştırılmayacak felaket kalıpları.
const FORBIDDEN_PATTERNS = [
  /\brm\s+-rf?\s+\/(?!\w)/,        // rm -rf / ya da rm -rf /<boşluk>
  /\brm\s+-rf?\s+~\s*$/,           // rm -rf ~
  /\brm\s+-rf?\s+\$HOME\s*$/,
  /:\(\)\s*\{.*\|\s*:.*&\s*\}\s*;:/, // fork bomb
  /\bmkfs(\.\w+)?\b/,              // disk biçimlendirme
  /\bdd\s+if=.*of=\/dev\/[sh]d/,   // diske raw yazma
  />\s*\/dev\/[sh]d/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
];

/**
 * Komutun risk sınıfını döndürür.
 * @returns {{level: "safe"|"approve"|"forbidden", reason?: string}}
 */
export function classifyCommand(cmd) {
  const trimmed = cmd.trim();

  // Hardcoded yasaklar her şeyin üstünde — kullanıcı 'allow' yapsa bile geçmez.
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(trimmed)) {
      return { level: "forbidden", reason: `Yasaklı kalıp: ${pat}` };
    }
  }

  // Kullanıcının kendi 'deny' listesindeyse de yasak.
  if (isAlwaysDenied(trimmed)) {
    return { level: "forbidden", reason: "Kullanıcı kalıcı olarak yasaklamış" };
  }

  // Kullanıcı 'her zaman izin ver' demişse onaysız geç.
  if (isAlwaysAllowed(trimmed)) {
    return { level: "safe", reason: "Kullanıcı tarafından kalıcı izinli" };
  }

  for (const pat of APPROVAL_PATTERNS) {
    if (pat.test(trimmed)) {
      return { level: "approve", reason: `Riskli kalıp: ${pat}` };
    }
  }

  for (const prefix of SAFE_PREFIXES) {
    if (trimmed === prefix || trimmed.startsWith(prefix + " ")) {
      return { level: "safe" };
    }
  }

  return { level: "approve", reason: "Bilinmeyen komut — emniyet için onay isteniyor" };
}

// Dosya yazma işlemleri için yol kontrolü: ev dizini dışına ya da kritik yerlere yazmasın.
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
