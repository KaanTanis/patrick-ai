// Onay (confirmer) implementasyonları.
//
// Üç farklı confirmer:
//   • createTerminalConfirmer(rl) — interaktif REPL için, parent rl'i paylaşır
//   • createDenyConfirmer()       — print/non-interactive mod için, hep "no"
//   • createCompoundConfirmer({ terminal, web }) — web UI ile paralel, ilk kazanır

import readline, { type Interface as Readline } from "node:readline";
import pc from "picocolors";
import type { ApprovalContext, Confirmer, ConfirmerDecision, Logger } from "./types.js";

// rl.question'ı parent listener'larıyla çakışmadan çağırmanın yolu.
async function askLine(rl: Readline | null, question: string): Promise<string> {
  if (!rl) {
    return new Promise((resolve) => {
      const tmp = readline.createInterface({ input: process.stdin, output: process.stdout });
      tmp.question(question, (a) => { tmp.close(); resolve(a); });
    });
  }
  const lineListeners = rl.listeners("line").slice();
  rl.removeAllListeners("line");
  // Node readline TS tipinde 'paused' public değil; runtime'da var
  const wasPaused = (rl as unknown as { paused: boolean }).paused;
  if (wasPaused) rl.resume();
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      for (const l of lineListeners) rl.on("line", l as (input: string) => void);
      if (wasPaused) rl.pause();
      resolve(answer);
    });
  });
}

export function createTerminalConfirmer(rl: Readline | null): Confirmer {
  return {
    async confirm(message, context): Promise<ConfirmerDecision> {
      const sug = (context as { suggestedPattern?: string }).suggestedPattern;
      const opts = sug ? "[y/N/a=her zaman izin]" : "[y/N]";
      const answer = await askLine(rl, pc.yellow(`${message} ${opts} `));
      const a = String(answer).trim().toLowerCase();
      if (a === "a" || a === "always") return "always";
      if (/^y/.test(a)) return "yes";
      return "no";
    },
  };
}

/** Print/non-interactive modda kullanılır: hiç sormaz, otomatik reddeder. */
export function createDenyConfirmer({ log }: { log?: Logger } = {}): Confirmer {
  return {
    async confirm(_message, context): Promise<ConfirmerDecision> {
      log?.warn?.("non-interactive: onay otomatik reddedildi", (context as ApprovalContext).kind);
      return "no";
    },
  };
}

interface WebPendingHandle {
  promise: Promise<ConfirmerDecision>;
  cancel: () => void;
}
interface WebApprovalRegistrar {
  registerPendingApproval(context: ApprovalContext & { message?: string }): WebPendingHandle;
}

/** Terminal + Web onay sorularını paralel çalıştırır; ilk yanıt kazanır. */
export function createCompoundConfirmer({
  terminal,
  web,
}: { terminal: Confirmer; web: WebApprovalRegistrar | null }): Confirmer {
  if (!web) return terminal;
  return {
    async confirm(message, context): Promise<ConfirmerDecision> {
      const handle = web.registerPendingApproval({ ...context, message });
      const t = terminal.confirm(message, context).then((d): { from: "terminal"; d: ConfirmerDecision } => ({ from: "terminal", d }));
      const w = handle.promise.then((d): { from: "web"; d: ConfirmerDecision } => ({ from: "web", d }));
      const winner = await Promise.race([t, w]);
      if (winner.from === "terminal") handle.cancel();
      return winner.d === "always" ? "always" : winner.d === "yes" ? "yes" : "no";
    },
  };
}
