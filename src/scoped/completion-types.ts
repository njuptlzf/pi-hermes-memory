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

export interface MemoryCompletionResult {
  readonly text: string;
  readonly ok: boolean;
  readonly error?: string;
}

export type MemoryCompletion = (req: MemoryCompletionRequest) => Promise<MemoryCompletionResult>;
