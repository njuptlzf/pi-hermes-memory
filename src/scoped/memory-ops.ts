/**
 * Shared "prompt → injected completion → parsed operations → applied" runner
 * for the three scoped background memory features: consolidation, review and
 * flush. All three have the same shape; only the prompt and the shrink policy
 * differ. Keeping one runner means the safety properties (bounded, no spawn,
 * structured failure, no throw into the write path) hold identically.
 *
 * The store is passed explicitly — never a module global. `await complete()`
 * yields the event loop, so a shared ref could be overwritten by another
 * tenant's run and cross-contaminate writes.
 */

import type { MemoryCompletion, MemoryCompletionResult } from "./completion-types.js";
import {
  applyReviewOperations,
  parseReviewOperations,
  type ReviewMemoryOperation,
} from "../handlers/review-memory-ops.js";
import type { MemoryStore } from "../store/memory-store.js";

export interface RunMemoryOpsOptions {
  readonly store: MemoryStore;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly complete: MemoryCompletion;
  readonly signal?: AbortSignal;
  /** Consolidation requires a net shrink; review/flush do not. */
  readonly requireShrink?: boolean;
  /** Restrict every emitted operation to this target. */
  readonly expectedTarget?: ReviewMemoryOperation["target"];
}

export interface MemoryOpsOutcome {
  readonly appliedCount: number;
  readonly ok: boolean;
  readonly error?: string;
  readonly aborted?: boolean;
}

/**
 * Run one bounded completion and apply whatever operations it yields.
 *
 * Never throws: every failure path returns a structured outcome so callers can
 * map it to their own result type without a try/catch. The completion callback
 * is host-owned and already enforces the hard timeout/budget.
 */
export async function runMemoryOps(options: RunMemoryOpsOptions): Promise<MemoryOpsOutcome> {
  const { store, complete, signal } = options;
  if (signal?.aborted) return { appliedCount: 0, ok: false, aborted: true, error: "aborted" };

  let completion: MemoryCompletionResult;
  try {
    completion = await complete({
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      signal,
    });
  } catch (err) {
    return { appliedCount: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  if (!completion.ok) return { appliedCount: 0, ok: false, error: completion.error ?? "completion failed" };
  if (signal?.aborted) return { appliedCount: 0, ok: false, aborted: true, error: "aborted" };

  const operations = parseReviewOperations(completion.text);
  if (operations === null) return { appliedCount: 0, ok: false, error: "could not parse memory operations" };
  if (operations.length === 0) return { appliedCount: 0, ok: true };

  try {
    const applied = await applyReviewOperations(store, null, operations, null, null, {
      requireAtomicShrink: options.requireShrink === true,
      expectedTarget: options.expectedTarget,
      signal,
    });
    if (applied.aborted && applied.appliedCount === 0) {
      return { appliedCount: 0, ok: false, aborted: true, error: "aborted" };
    }
    if (applied.error) return { appliedCount: 0, ok: false, error: applied.error };
    return { appliedCount: applied.appliedCount, ok: true };
  } catch (err) {
    return { appliedCount: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
