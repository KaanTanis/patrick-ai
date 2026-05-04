import OpenAI from "openai";
import pc from "picocolors";
import { TOOL_SCHEMAS, runTool, setEmitter, setConfirmer } from "./tools.js";

export class Agent {
  constructor({ apiKey, model, systemPrompt, autoApprove = false, emitter, confirmer, sessionLogger }) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
    this.autoApprove = autoApprove;
    this.systemPrompt = systemPrompt;
    this.messages = [{ role: "system", content: systemPrompt }];
    this.sessionLogger = sessionLogger;
    this._emitter = emitter;
    if (emitter) setEmitter(emitter);
    if (confirmer) setConfirmer(confirmer);
  }

  setEmitter(e) { this._emitter = e; setEmitter(e); }
  setConfirmer(c) { setConfirmer(c); }

  reset() {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  async send(userMessage, { onText } = {}) {
    this.messages.push({ role: "user", content: userMessage });
    this.sessionLogger?.log("user", { content: userMessage });

    const MAX_STEPS = 25;
    for (let step = 0; step < MAX_STEPS; step++) {
      const resp = await this.client.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: TOOL_SCHEMAS,
        tool_choice: "auto",
      });

      const msg = resp.choices[0].message;
      this.messages.push(msg);

      if (msg.content && msg.content.trim()) {
        const text = msg.content.trim();
        console.log();
        console.log(pc.bold(pc.magenta("patrick:")), text);
        onText?.(text);
        this.sessionLogger?.log("assistant", { content: text });
        try { this._emitter?.emit?.("assistant:text", { text }); } catch {}
      }

      const calls = msg.tool_calls || [];
      if (calls.length === 0) return msg.content || "";

      for (const call of calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || "{}"); } catch {}

        this.sessionLogger?.log("tool_call", { name: call.function.name, args });

        const result = await runTool(
          { name: call.function.name, args },
          { autoApprove: this.autoApprove }
        );

        this.sessionLogger?.log("tool_result", { name: call.function.name, ok: result.ok });

        this.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: truncate(result.output, 30_000),
        });
      }
    }

    return "[Maks. adım sayısı aşıldı, durdum.]";
  }
}

function truncate(s, n) {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n[...${s.length - n} karakter kesildi...]`;
}
