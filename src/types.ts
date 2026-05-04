// Patrick — ortak tip tanımları.
// Modüller arası kontratları burada toplarız ki refactor sırasında tek noktayı değiştir.

import type { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type OpenAI from "openai";

// =============================================================================
// Config
// =============================================================================

export interface PathConfig {
  patrickDir: string;
  historyFile: string;
}

export interface Config {
  apiKey: string;
  model: string;
  autoApprove: boolean;

  agentMaxSteps: number;
  toolTimeoutSec: number;
  shellMaxOutputBytes: number;
  toolResultMaxChars: number;

  webEnabled: boolean;
  webPort: number;
  webOpenBrowser: boolean;
  webHost: string;

  historySize: number;
  memoryInjectLimit: number;

  sessionKeepDays: number;
  resumeOnStart: boolean;
  resumeMaxMessages: number;
  persistChunks: boolean;

  // Summarization (Faz 3)
  compactEnabled: boolean;
  compactThresholdTokens: number;   // bu eşik aşılınca otomatik kompakt
  compactKeepLastMessages: number;  // kompakt sonrası saklanan son N mesaj

  logLevel: LogLevel;
  paths: PathConfig;
}

// =============================================================================
// Logger
// =============================================================================

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface Logger {
  error: (...args: unknown[]) => void;
  warn:  (...args: unknown[]) => void;
  info:  (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

// =============================================================================
// Safety / Permissions
// =============================================================================

export type RiskLevel = "safe" | "approve" | "forbidden";

export interface Classification {
  level: RiskLevel;
  reason?: string;
  segments?: SegmentClassification[];
}

export interface SegmentClassification {
  segment: string;
  level: RiskLevel;
  reason?: string;
}

// =============================================================================
// Confirmer (onay)
// =============================================================================

export type ConfirmerDecision = "yes" | "no" | "always";

export type ApprovalContext =
  | {
      kind: "shell";
      command: string;
      purpose?: string;
      cwd?: string;
      risk: RiskLevel;
      reason?: string;
      suggestedPattern?: string;
      message?: string;
    }
  | {
      kind: "write";
      path: string;
      purpose?: string;
      size: number;
      message?: string;
    }
  | {
      kind: "kill_port";
      ports: number[];
      force?: boolean;
      procs: KilledProcess[];
      message?: string;
    };

export interface KilledProcess {
  command: string;
  pid: number;
  user: string;
  port: string;
}

export interface Confirmer {
  confirm(message: string, context: ApprovalContext): Promise<ConfirmerDecision>;
}

// =============================================================================
// Tools
// =============================================================================

export interface ToolResult {
  ok: boolean;
  output: string;
}

export interface ToolContext {
  confirmer: Confirmer;
  emitter: EventEmitter;
  autoApprove: boolean;
  signal: AbortSignal;
  config: Config;
  log: Logger;
  /** Bir alt-süreç başladığında agent'a bildir (cancel için). Opsiyonel. */
  onChild?: (child: ChildProcess) => void;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface Tool<Args = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JSONSchema;
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
}

// OpenAI'a gönderilen schema şekli
export interface OpenAIToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

// =============================================================================
// Agent / Messages
// =============================================================================

// OpenAI tip alias'ları (kütüphane tipini kullan)
export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ChatToolCall = OpenAI.Chat.Completions.ChatCompletionMessageToolCall;
export type Usage = OpenAI.Completions.CompletionUsage;

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastTurn: TurnUsage | null;
}

export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// =============================================================================
// Session events (UI replay + persist)
// =============================================================================

export interface SessionEvent {
  ts: number;
  type: string;
  payload: unknown;
}

export interface SessionMeta {
  id: string;
  started: string;
  ended: string | null;
  model?: string;
  eventCount: number;
  messageCount: number;
}

// =============================================================================
// Session logger interface (state.js'in newSessionLogger döndürüsü)
// =============================================================================

import type { SessionStore } from "./session-store.js";

export interface SessionLogger {
  id: string;
  store: SessionStore;
  log(type: string, payload: unknown): void;
  saveMessages(messages: ChatMessage[]): void;
  close(): Promise<void>;
}

// =============================================================================
// Web protocol
// =============================================================================

export type ServerEvent =
  | { type: "hello"; payload: { cwd: string; model: string; sessionId: string | null; cursor: number } }
  | { type: "user:text"; payload: { text: string }; cursor?: number }
  | { type: "assistant:start"; payload: Record<string, never> }
  | { type: "assistant:chunk"; payload: { delta: string }; cursor?: number }
  | { type: "assistant:done"; payload: { text: string } }
  | { type: "assistant:text"; payload: { text: string }; cursor?: number }
  | { type: "tool:start"; payload: { name: string; args: unknown }; cursor?: number }
  | { type: "tool:end"; payload: { name: string; ok: boolean; output: string }; cursor?: number }
  | { type: "shell:propose"; payload: unknown; cursor?: number }
  | { type: "shell:output"; payload: unknown; cursor?: number }
  | { type: "write:propose"; payload: unknown; cursor?: number }
  | { type: "kill_port:propose"; payload: unknown; cursor?: number }
  | { type: "agent:usage"; payload: { turn: TurnUsage; total: UsageStats }; cursor?: number }
  | { type: "approval:request"; payload: ApprovalContext & { id: string } }
  | { type: "approval:resolved"; payload: { id: string; decision: ConfirmerDecision } }
  | { type: "error"; payload: { message: string } };

export type ClientMessage =
  | { type: "auth"; token: string }
  | { type: "user"; payload: { text: string } }
  | { type: "approval:response"; payload: { id: string; decision: ConfirmerDecision } }
  | { type: "ping" };
