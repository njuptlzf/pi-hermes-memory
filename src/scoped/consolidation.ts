/**
 * Scoped (in-process host) auto-consolidation via an injected LLM callback.
 *
 * The full entry consolidates through `pi.exec()` subprocesses or pi's
 * modelRegistry — both unavailable to a provider mounted inside a host that
 * owns process lifetime and credentials. The scoped port instead receives a
 * `MemoryCompletion` callback from the host (see the protocol contract) and
 * stays a pure consumer: no spawn, no env, no model/credential access.
 *
 * Bounded by construction: one completion per trigger, the host owns the hard
 * timeout/budget on the callback, and application is atomic-shrink only. Any
 * failure degrades to "not consolidated" and never throws into the memory
 * write path — a missed consolidation is recoverable, a broken write is not.
 */

import type { MemoryCompletion } from "./completion-types.js";
import {
  applyReviewOperations,
  parseReviewOperations,
} from "../handlers/review-memory-ops.js";
import type { MemoryStore } from "../store/memory-store.js";
import { DIRECT_CONSOLIDATION_SYSTEM_PROMPT, ENTRY_DELIMITER } from "../constants.js";
import type { ConsolidationResult } from "../types.js";

export interface ScopedConsolidationOptions {
  /** The target whose entries are being consolidated. */
  readonly target: "memory" | "user" | "failure";
  /** Tool-facing target label used in the prompt and operation filtering. */
  readonly toolTarget?: "memory" | "user" | "failure" | "project";
  /** Completion callback injected by the host. */
  readonly complete: MemoryCompletion;
  /** Extra cancellation from the caller (e.g. session teardown). */
  readonly signal?: AbortSignal;
}

/** Entries for a target, read through the store's own surface. */
function entriesFor(store: MemoryStore, target: ScopedConsolidationOptions["target"]): string[] {
  if (target === "memory") return store.getMemoryEntries();
  if (target === "user") return store.getUserEntries();
  return store.getAllFailureEntries();
}

function labelFor(target: ScopedConsolidationOptions["target"], toolTarget: string): string {
  if (toolTarget === "project") return "project memory";
  if (target === "user") return "user profile";
  if (target === "failure") return "failure memory";
  return "scope memory";
}

/**
 * Run one bounded consolidation attempt through the injected completion.
 *
 * Returns a `ConsolidationResult` on every path — including failure — so the
 * caller can hand it straight back to `MemoryStore`'s overflow handling.
 */
export async function consolidateViaCompletion(
  store: MemoryStore,
  options: ScopedConsolidationOptions,
): Promise<ConsolidationResult> {
  const { target, complete, signal } = options;
  const toolTarget = options.toolTarget ?? target;

  if (signal?.aborted) return { consolidated: false, error: "aborted" };

  const entries = entriesFor(store, target);
  if (entries.length === 0) return { consolidated: false, error: "nothing to consolidate" };

  const userPrompt = [
    `--- Current ${labelFor(target, toolTarget)} Entries (target: '${toolTarget}') ---`,
    entries.join(ENTRY_DELIMITER) || "(empty)",
    "",
    `Only emit operations with "target": "${toolTarget}".`,
  ].join("\n");

  let completion;
  try {
    completion = await complete({ systemPrompt: DIRECT_CONSOLIDATION_SYSTEM_PROMPT, userPrompt, signal });
  } catch (err) {
    // A host callback that throws is a host bug, but it must not break the
    // memory write that triggered consolidation.
    return { consolidated: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (!completion.ok) return { consolidated: false, error: completion.error ?? "completion failed" };
  if (signal?.aborted) return { consolidated: false, error: "aborted" };

  const operations = parseReviewOperations(completion.text);
  if (operations === null) return { consolidated: false, error: "could not parse consolidation operations" };
  if (operations.length === 0) return { consolidated: false, error: "completion produced no operations" };

  try {
    const applied = await applyReviewOperations(store, null, operations, null, null, {
      requireAtomicShrink: true,
      expectedTarget: toolTarget,
      signal,
    });
    if (applied.aborted && applied.appliedCount === 0) return { consolidated: false, error: "aborted" };
    if (applied.error) return { consolidated: false, error: applied.error };
    if (applied.appliedCount === 0) return { consolidated: false, error: "no operations applied" };
    return { consolidated: true };
  } catch (err) {
    return { consolidated: false, error: err instanceof Error ? err.message : String(err) };
  }
}
