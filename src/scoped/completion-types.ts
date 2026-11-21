/**
 * Structural mirror of the host's `MemoryCompletion` protocol type.
 *
 * The fork deliberately does NOT import `@njuptlzf/agent-chat-protocol` — it
 * must stay host-neutral and loadable by any host. TypeScript structural
 * typing means a host's callback satisfies this shape without a shared import.
 * Keep these fields in sync with `packages/protocol/src/memory-provider.ts`.
 */

export interface MemoryCompletionRequest {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * Optional usage/cost reported by the host. All fields stay optional so a host
 * that only returns `{ text, ok }` remains structurally compatible.
 */
export interface MemoryCompletionUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
}

export interface MemoryCompletionResult {
  readonly text: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly usage?: MemoryCompletionUsage;
}

export type MemoryCompletion = (req: MemoryCompletionRequest) => Promise<MemoryCompletionResult>;
