import OpenAI from "openai";
import { dispatchTool, getOpenAISchemas } from "./tools/index.js";
import { createLogger } from "./logger.js";
import type {
  ChatMessage, ChatToolCall, Confirmer, Config, Logger,
  ToolContext, TurnUsage, UsageStats,
} from "./types.js";
import type { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";

const log: Logger = createLogger("agent");

interface AgentOpts {
  config: Config;
  confirmer: Confirmer;
  emitter?: EventEmitter;
}

interface SendOpts {
  onText?: (text: string) => void;
  onChunk?: (delta: string) => void;
}

const NULL_EMITTER = { emit: () => false } as unknown as EventEmitter;

/**
 * Patrick agent. OpenAI function-calling döngüsü.
 *
 * Tasarım kuralları:
 *  - Hiçbir module-level state taşımaz; her şey ctx ile aşağı iner.
 *  - messages dizisi her zaman geçerli (her tool_call için yanıt push'u garantili).
 *  - Token usage takibi: cumulative + son tur.
 *  - AbortController desteği: in-flight tool çağrıları kesilebilir.
 *  - Auto-compaction: token tahmini eşiği aşarsa, en eski mesajları model ile özetler
 *    ve yerine tek bir "[geçmiş özeti]" mesajı koyar (Faz 3).
 */
export class Agent {
  readonly config: Config;
  readonly client: OpenAI;
  readonly model: string;
  autoApprove: boolean;
  systemPrompt: string = "";
  messages: ChatMessage[] = [];
  readonly confirmer: Confirmer;
  readonly emitter: EventEmitter;

  usage: UsageStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0, lastTurn: null };
  private _abort: AbortController | null = null;
  private _activeChildren: Set<ChildProcess> = new Set();
  private _lastTurnMsg: ChatMessage | null = null;

  constructor({ config, confirmer, emitter }: AgentOpts) {
    this.config = config;
    this.client = new OpenAI({ apiKey: config.apiKey });
    this.model = config.model;
    this.autoApprove = config.autoApprove;
    this.confirmer = confirmer;
    this.emitter = emitter ?? NULL_EMITTER;
  }

  setSystemPrompt(text: string): void {
    this.systemPrompt = text;
    this.reset();
  }

  reset(): void {
    this.messages = this.systemPrompt
      ? [{ role: "system", content: this.systemPrompt }]
      : [];
  }

  /** İptal: AbortController + tüm child process'ler. */
  cancel(): void {
    if (this._abort) {
      try { this._abort.abort(); } catch { /* ignore */ }
    }
    for (const child of this._activeChildren) {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
    }
  }

  /** Devam eden bir API/tool turu var mı? */
  get isBusy(): boolean { return this._abort !== null; }

  /**
   * Eksik tool yanıtlarını sentetik olarak tamamla. Bozuk dizi onarmak için.
   */
  repair(): number {
    let added = 0;
    const newMsgs: ChatMessage[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      newMsgs.push(m);
      if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const expected = new Set(m.tool_calls.map((c) => c.id));
        let j = i + 1;
        const seen = new Set<string>();
        while (j < this.messages.length && this.messages[j]!.role === "tool") {
          const t = this.messages[j] as ChatMessage & { tool_call_id?: string };
          if (t.tool_call_id) seen.add(t.tool_call_id);
          newMsgs.push(this.messages[j]!);
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
   * Eski bir oturumun mesaj dizisini yükle (resume).
   * - System prompt'u şu anki ile değiştirir (yeni cwd, yeni zaman vs.).
   * - Eski mesajların son N tanesini saklar.
   * - tool_call/tool eşleşmelerini bozmamak için kesim noktasını dikkatli seçer.
   */
  loadSnapshot(oldMessages: ChatMessage[]): number {
    if (!Array.isArray(oldMessages) || oldMessages.length === 0) return 0;

    const tail = oldMessages.filter((m) => m.role !== "system");
    const max = Math.max(2, this.config.resumeMaxMessages || 30);
    let cut = Math.max(0, tail.length - max);
    while (cut < tail.length && tail[cut]!.role === "tool") cut--;
    if (cut < 0) cut = 0;

    const restored = tail.slice(cut);
    this.messages = this.systemPrompt
      ? [{ role: "system", content: this.systemPrompt }, ...restored]
      : restored.slice();

    const repaired = this.repair();
    return restored.length + repaired;
  }

  /**
   * Bir kullanıcı turunu işler: API çağrı + tool çağrı döngüsü.
   */
  async send(userMessage: string, { onText, onChunk }: SendOpts = {}): Promise<string> {
    if (!this.systemPrompt) {
      throw new Error("Agent.setSystemPrompt() çağrılmadan send() yapamazsın.");
    }

    // Kullanıcı mesajını eklemeden ÖNCE, mevcut mesaj dizisi token eşiğini aşıyorsa
    // önce kompakt et — yeni mesajın bağlamı taze kalsın.
    if (this.config.compactEnabled) {
      await this._maybeCompactMessages();
    }

    this.messages.push({ role: "user", content: userMessage });
    this.emitter.emit("user:text", { text: userMessage });

    const turnUsage: TurnUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this._abort = new AbortController();

    try {
      for (let step = 0; step < this.config.agentMaxSteps; step++) {
        log.debug("step", step, "messages", this.messages.length);

        let msg: ChatMessage;
        try {
          msg = await this._streamOneTurn(turnUsage, onChunk);
        } catch (err) {
          const e = err as Error & { name?: string };
          if (e?.name === "AbortError" || this._abort.signal.aborted) {
            log.warn("API çağrısı iptal edildi");
            return "[iptal edildi]";
          }
          throw err;
        }

        const msgContent = (msg as { content?: string | null }).content;
        if (msgContent && typeof msgContent === "string" && msgContent.trim()) {
          const text = msgContent.trim();
          onText?.(text);
          this.emitter.emit("assistant:text", { text });
        }

        const calls = (msg as { tool_calls?: ChatToolCall[] }).tool_calls ?? [];
        if (calls.length === 0) break;

        const respondedIds = new Set<string>();
        let loopErr: Error | null = null;
        try {
          for (const call of calls) {
            if (this._abort.signal.aborted) { loopErr = new Error("aborted"); break; }
            let args: Record<string, unknown> = {};
            try { args = JSON.parse((call as ChatToolCall & { function: { arguments?: string } }).function.arguments || "{}"); } catch { /* malformed json */ }

            const ctx: ToolContext = {
              confirmer: this.confirmer,
              emitter: this.emitter,
              autoApprove: this.autoApprove,
              signal: this._abort.signal,
              config: this.config,
              log,
              onChild: (c) => {
                this._activeChildren.add(c);
                c.on("exit", () => this._activeChildren.delete(c));
              },
            };
            const fn = (call as ChatToolCall & { function: { name: string } }).function;
            const result = await dispatchTool(fn.name, args, ctx);
            this.messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: truncate(result?.output ?? "(empty)", this.config.toolResultMaxChars),
            });
            respondedIds.add(call.id);
          }
        } catch (err) {
          loopErr = err as Error;
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

  /**
   * Bir tur için OpenAI'a streaming çağrı yapar, chunk'ları toparlayıp
   * tek bir assistant mesajı inşa eder. Mesajı `messages` dizisine push eder
   * (kısmi olsa bile, hata/abort durumlarında dahi).
   */
  private async _streamOneTurn(turnUsage: TurnUsage, onChunk?: (d: string) => void): Promise<ChatMessage> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.messages,
      tools: getOpenAISchemas(),
      tool_choice: "auto",
      stream: true,
      stream_options: { include_usage: true },
    }, { signal: this._abort!.signal });

    let contentBuf = "";
    interface ToolAcc { id: string; type: "function"; function: { name: string; arguments: string }; }
    const toolAcc: (ToolAcc | undefined)[] = [];
    let usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null = null;
    let firstChunkEmitted = false;

    const emitChunk = (delta: string): void => {
      if (!firstChunkEmitted) {
        firstChunkEmitted = true;
        this.emitter.emit("assistant:start", {});
      }
      this.emitter.emit("assistant:chunk", { delta });
      onChunk?.(delta);
    };

    try {
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage;

        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as {
          content?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };

        if (delta?.content) {
          contentBuf += delta.content;
          emitChunk(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolAcc[idx]) {
              toolAcc[idx] = {
                id: tc.id || "",
                type: "function",
                function: { name: "", arguments: "" },
              };
            }
            const slot = toolAcc[idx]!;
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.function.name = tc.function.name;
            if (tc.function?.arguments) slot.function.arguments += tc.function.arguments;
          }
        }
      }
    } finally {
      const toolCalls = toolAcc.filter((t): t is ToolAcc => !!t && !!t.id);
      const msg: ChatMessage = toolCalls.length > 0
        ? { role: "assistant", content: contentBuf || null, tool_calls: toolCalls } as ChatMessage
        : { role: "assistant", content: contentBuf || null } as ChatMessage;
      this.messages.push(msg);

      if (firstChunkEmitted) {
        this.emitter.emit("assistant:done", { text: contentBuf });
      }

      if (usage) {
        turnUsage.promptTokens     += usage.prompt_tokens || 0;
        turnUsage.completionTokens += usage.completion_tokens || 0;
        turnUsage.totalTokens      += usage.total_tokens || 0;
      }

      this._lastTurnMsg = msg;
    }
    return this._lastTurnMsg!;
  }

  // ===========================================================================
  // SUMMARIZATION (Faz 3): context budama
  // ===========================================================================

  /**
   * Mesaj dizisinin yaklaşık token sayısını hesaplar.
   * Heuristic: 1 token ≈ 4 karakter (İngilizce ortalaması). Türkçe'de biraz fazla
   * olabilir ama eşiği abartmamak için %20 fazla sayıyoruz.
   */
  estimateTokens(messages: ChatMessage[] = this.messages): number {
    let chars = 0;
    for (const m of messages) {
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") chars += c.length;
      const tc = (m as { tool_calls?: ChatToolCall[] }).tool_calls;
      if (tc) for (const t of tc) chars += JSON.stringify(t).length;
    }
    return Math.ceil((chars / 4) * 1.2);
  }

  /**
   * Eşik aşılmadıysa no-op. Aşıldıysa eski mesajları model ile özetler ve yerine
   * tek bir "[geçmiş özeti]" assistant mesajı koyar. System mesajı + son
   * `compactKeepLastMessages` mesaj korunur.
   *
   * @returns özetlenen mesaj sayısı (0 ise no-op)
   */
  async _maybeCompactMessages(): Promise<number> {
    const tokens = this.estimateTokens();
    if (tokens < this.config.compactThresholdTokens) return 0;

    // System hariç gerçek mesajlar
    const sys = this.messages[0]?.role === "system" ? this.messages[0] : null;
    const body = sys ? this.messages.slice(1) : this.messages.slice();
    const keep = Math.max(2, this.config.compactKeepLastMessages);
    if (body.length <= keep) return 0;

    let cut = body.length - keep;
    // Tool eşleşmesini bozmamak için: cut noktası tool ile başlamasın
    while (cut < body.length && body[cut]!.role === "tool") cut++;
    // Cut'ın üstünde dangling tool_calls kalmamalı: assistant{tool_calls} varsa
    // onun TÜM tool yanıtlarını da kesime dahil et veya bırak. Basitlik için:
    // cut'tan önceki son mesajın tool_calls'ı varsa, onu KEEP'e kaydır.
    while (cut > 0) {
      const last = body[cut - 1] as ChatMessage & { tool_calls?: ChatToolCall[] };
      if (last.role === "assistant" && Array.isArray(last.tool_calls) && last.tool_calls.length) {
        cut--;
      } else break;
    }
    if (cut <= 0) return 0;

    const old = body.slice(0, cut);
    const tail = body.slice(cut);

    log.info(`auto-compact: ${old.length} eski mesajı özetliyorum (yaklaşık ${tokens} token)`);
    this.emitter.emit("agent:compact", { count: old.length, estTokens: tokens });

    let summaryText: string;
    try {
      summaryText = await this._summarize(old);
    } catch (err) {
      log.warn("özetleme başarısız, kompakt iptal:", (err as Error).message);
      return 0;
    }

    const summaryMsg: ChatMessage = {
      role: "assistant",
      content: `[Geçmiş Özeti — ${old.length} mesaj kompaktlandı]\n${summaryText}`,
    };

    this.messages = sys ? [sys, summaryMsg, ...tail] : [summaryMsg, ...tail];
    return old.length;
  }

  /**
   * Verilen mesajları model ile özetler. Sadece "user soruları + assistant cevapları"
   * dizisi olarak basit bir narrative üretmesi istenir; tool çağrı detayları kısa kalır.
   */
  private async _summarize(messages: ChatMessage[]): Promise<string> {
    const transcript = messages.map((m) => {
      const role = m.role;
      const content = typeof (m as { content?: unknown }).content === "string"
        ? ((m as { content: string }).content)
        : "";
      const tools = (m as { tool_calls?: ChatToolCall[] }).tool_calls;
      const toolPart = tools?.length
        ? ` [tool: ${tools.map((t) => (t as ChatToolCall & { function?: { name?: string } }).function?.name || "?").join(", ")}]`
        : "";
      const trimmedContent = content.length > 600 ? content.slice(0, 600) + "…" : content;
      return `[${role}]${toolPart} ${trimmedContent}`;
    }).join("\n");

    const resp = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: "Sen bir konuşma özetleyicisin. Verilen transkripti, agent'ın bağlamı koruyabilmesi için 6-12 madde halinde özetle. Türkçe yaz. Sadece bilgisel değer taşıyan kararları, açılan dosyaları, alınan sonuçları yaz; sohbet dolgusunu atla." },
        { role: "user", content: `Transkript:\n${transcript}` },
      ],
      // stream kapalı — özet kısa, beklemek sorun değil
    }, { signal: this._abort?.signal });

    return resp.choices[0]?.message?.content?.trim() || "(boş özet)";
  }
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return "";
  if (s.length <= n) return s;
  return s.slice(0, n) + `\n[...${s.length - n} karakter kesildi...]`;
}
