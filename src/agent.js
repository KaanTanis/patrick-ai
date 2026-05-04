import OpenAI from "openai";
import pc from "picocolors";
import { dispatchTool, getOpenAISchemas } from "./tools/index.js";
import { createLogger } from "./logger.js";

const log = createLogger("agent");

/**
 * Patrick agent. OpenAI function-calling döngüsü.
 *
 * Tasarım kuralları:
 *  - Hiçbir module-level state taşımaz; her şey ctx ile aşağı iner.
 *  - messages dizisi her zaman geçerli (her tool_call için yanıt push'u garantili)
 *  - Token usage takibi: cumulative + son tur ayrı tutulur.
 *  - AbortController desteği: in-flight tool çağrıları kesilebilir.
 */
export class Agent {
  constructor({ config, confirmer, emitter, sessionLogger }) {
    this.config = config;
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.autoApprove = config.autoApprove;
    this.systemPrompt = "";
    this.messages = [];
    this.confirmer = confirmer;
    this.emitter = emitter || { emit() {} };
    this.sessionLogger = sessionLogger;

    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, lastTurn: null };
    this._abort = null;
    this._activeChildren = new Set();
  }

  setSystemPrompt(text) {
    this.systemPrompt = text;
    this.reset();
  }

  reset() {
    this.messages = this.systemPrompt
      ? [{ role: "system", content: this.systemPrompt }]
      : [];
  }

  /**
   * Devam eden iş varsa iptal et: AbortController + alt-süreçleri öldür.
   */
  cancel() {
    if (this._abort) {
      try { this._abort.abort(); } catch {}
    }
    for (const child of this._activeChildren) {
      try { child.kill("SIGTERM"); } catch {}
    }
  }

  /**
   * Mesaj dizisini "geçerli" hale getir: her assistant{tool_calls} için
   * eksik tool yanıtlarını sentetik olarak tamamla. Bozuk dizi onarmak için.
   */
  repair() {
    let added = 0;
    const newMsgs = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      newMsgs.push(m);
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const expected = new Set(m.tool_calls.map((c) => c.id));
        let j = i + 1;
        const seen = new Set();
        while (j < this.messages.length && this.messages[j].role === "tool") {
          seen.add(this.messages[j].tool_call_id);
          newMsgs.push(this.messages[j]);
          j++;
        }
        for (const id of expected) {
          if (!seen.has(id)) {
            newMsgs.push({
              role: "tool",
              tool_call_id: id,
              content: "(missing — repaired)",
            });
            added++;
          }
        }
        i = j - 1;
      }
    }
    this.messages = newMsgs;
    return added;
  }

  /**
   * Bir kullanıcı turunu işler: API çağrı + tool çağrı döngüsü.
   * @param {string} userMessage
   * @param {{ onText?: (s:string)=>void }} opts
   */
  async send(userMessage, { onText } = {}) {
    if (!this.systemPrompt) {
      throw new Error("Agent.setSystemPrompt() çağrılmadan send() yapamazsın.");
    }

    this.messages.push({ role: "user", content: userMessage });
    this.sessionLogger?.log("user", { content: userMessage });

    const turnUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this._abort = new AbortController();

    try {
      for (let step = 0; step < this.config.agentMaxSteps; step++) {
        log.debug("step", step, "messages", this.messages.length);

        let resp;
        try {
          resp = await this.client.chat.completions.create({
            model: this.model,
            messages: this.messages,
            tools: getOpenAISchemas(),
            tool_choice: "auto",
          }, { signal: this._abort.signal });
        } catch (err) {
          if (err?.name === "AbortError" || this._abort.signal.aborted) {
            log.warn("API çağrısı iptal edildi");
            return "[iptal edildi]";
          }
          throw err;
        }

        if (resp.usage) {
          turnUsage.promptTokens     += resp.usage.prompt_tokens || 0;
          turnUsage.completionTokens += resp.usage.completion_tokens || 0;
          turnUsage.totalTokens      += resp.usage.total_tokens || 0;
        }

        const msg = resp.choices[0].message;
        this.messages.push(msg);

        if (msg.content && msg.content.trim()) {
          const text = msg.content.trim();
          console.log();
          console.log(pc.bold(pc.magenta("patrick:")), text);
          onText?.(text);
          this.sessionLogger?.log("assistant", { content: text });
          this.emitter.emit("assistant:text", { text });
        }

        const calls = msg.tool_calls || [];
        if (calls.length === 0) break;

        // Tool sonuç push'u garantili: try/finally + invariant
        const respondedIds = new Set();
        let loopErr = null;
        try {
          for (const call of calls) {
            if (this._abort.signal.aborted) { loopErr = new Error("aborted"); break; }
            let args = {};
            try { args = JSON.parse(call.function.arguments || "{}"); } catch {}

            this.sessionLogger?.log("tool_call", { name: call.function.name, args });

            const ctx = {
              confirmer: this.confirmer,
              emitter: this.emitter,
              autoApprove: this.autoApprove,
              signal: this._abort.signal,
              config: this.config,
              log,
              onChild: (c) => this._activeChildren.add(c.on("exit", () => this._activeChildren.delete(c))),
            };
            const result = await dispatchTool(call.function.name, args, ctx);
            this.sessionLogger?.log("tool_result", { name: call.function.name, ok: result?.ok });
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: truncate(result?.output ?? "(empty)", this.config.toolResultMaxChars),
            });
            respondedIds.add(call.id);
          }
        } catch (err) {
          loopErr = err;
        } finally {
          for (const call of calls) {
            if (!respondedIds.has(call.id)) {
              this.messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: `İç hata: tool sonucu kaydedilemedi${loopErr ? ` (${loopErr.message})` : ""}`,
              });
            }
          }
        }
        if (loopErr) {
          if (loopErr.message === "aborted") return "[iptal edildi]";
          throw loopErr;
        }
      }
    } finally {
      this.usage.promptTokens     += turnUsage.promptTokens;
      this.usage.completionTokens += turnUsage.completionTokens;
      this.usage.totalTokens      += turnUsage.totalTokens;
      this.usage.lastTurn = turnUsage;
      this.emitter.emit("agent:usage", { turn: turnUsage, total: this.usage });
      this._abort = null;
    }

    return "";
  }
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n[...${s.length - n} karakter kesildi...]`;
}
