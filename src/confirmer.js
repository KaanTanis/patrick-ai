// Onay (confirmer) implementasyonları.
//
// Confirmer interface:
//   { confirm(message, context) -> Promise<"yes"|"no"|"always"> }
//
// Üç farklı confirmer var:
//   • createTerminalConfirmer(rl) — interaktif REPL için, parent rl'i paylaşır
//   • createDenyConfirmer()       — print/non-interactive mod için, hep "no"
//   • createCompoundConfirmer({ terminal, web }) — web UI ile paralel, ilk kazanır

import readline from "node:readline";
import pc from "picocolors";

// rl.question'ı parent listener'larıyla çakışmadan çağırmanın yolu.
async function askLine(rl, question) {
  if (!rl) {
    return new Promise((resolve) => {
      const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
      tmp.question(question, (a) => { tmp.close(); resolve(a); });
    });
  }
  const lineListeners = rl.listeners("line").slice();
  rl.removeAllListeners("line");
  const wasPaused = rl.paused;
  if (wasPaused) rl.resume();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      for (const l of lineListeners) rl.on("line", l);
      if (wasPaused) rl.pause();
      resolve(answer);
    });
  });
}

export function createTerminalConfirmer(rl) {
  return {
    async confirm(message, context) {
      const opts = context?.suggestedPattern ? "[y/N/a=her zaman izin]" : "[y/N]";
      const answer = await askLine(rl, pc.yellow(`${message} ${opts} `));
      const a = String(answer).trim().toLowerCase();
      if (a === "a" || a === "always") return "always";
      if (/^y/.test(a)) return "yes";
      return "no";
    },
  };
}

/** Print/non-interactive modda kullanılır: hiç sormaz, otomatik reddeder. */
export function createDenyConfirmer({ log } = {}) {
  return {
    async confirm(message, context) {
      log?.warn?.("non-interactive: onay otomatik reddedildi", context?.kind || "?");
      return "no";
    },
  };
}

/**
 * Terminal + Web onay sorularını paralel çalıştırır; ilk yanıt kazanır.
 * Web kazanırsa terminal stdin'i hâlâ Enter bekler — kullanıcının bunu bilmesi
 * gerekir. Ekrandaki sonuç doğru, sadece bir kez Enter'la geçer.
 */
export function createCompoundConfirmer({ terminal, web }) {
  if (!web) return terminal;
  return {
    async confirm(message, context) {
      const handle = web.registerPendingApproval({ ...context, message });
      const t = terminal.confirm(message, context).then((d) => ({ from: "terminal", d }));
      const w = handle.promise.then((d) => ({ from: "web", d }));
      const winner = await Promise.race([t, w]);
      if (winner.from === "terminal") handle.cancel();
      return winner.d === "always" ? "always" : winner.d === "yes" ? "yes" : "no";
    },
  };
}
