/**
 * Manual bounded compaction of the tenant's memory stores (backlog #12).
 *
 * Design: docs/fork/MEMORY-COMPACT-DESIGN.md. One host-triggered pass that
 * brings the scoped `memory` and `failure` stores back inside their capacity
 * goal, reusing `consolidateViaCompletion` — the SAME single-prompt shrink
 * path the overflow-triggered auto-consolidation uses, with the same
 * requireShrink guarantee. No upstream file is touched; the upstream manual
 * surface (`/memory-consolidate`) is a forced class — inert `registerCommand`
 * in rpc, a subprocess child the scoped adapter must never spawn, and a
 * project target the tenant model rejects.
 *
 * Boundary rules encoded here:
 *  - targets are `memory` and `failure` ONLY. The shared profile is capped
 *    small and never consolidated (entry.ts mount comment, layered-store.ts:
 *    setConsolidator routes to the scope store — mirroring a consolidator
 *    onto the profile would let one scope's model call rewrite another
 *    scope's view of the user).
 *  - a store already within goal is a free no-op: no completion is paid
 *    (upstream treats within-goal as a clean no-op, auto-consolidate.ts
 *    returns `{consolidated:true, rounds:0}` without touching the LLM).
 *  - the pass claims the tenant's shared BackgroundGate for its whole run,
 *    so review/flush/correction and a manual compact never interleave writes
 *    on the same store. A busy gate reports `deferred` — retry guidance, not
 *    a failure (mirrors ConsolidationResult.deferred, types.ts:208-214).
 */

import type { MemoryStore } from "../store/memory-store.js";
import type { ConsolidationResult } from "../types.js";
import type { MemoryCompletion } from "./completion-types.js";
import { consolidateViaCompletion } from "./consolidation.js";
import type { BackgroundGate } from "./background-gate.js";

/** The two scope-owned stores; "user" is absent by design — see header. */
export type CompactionTarget = "memory" | "failure";

export interface CompactionTargetResult {
  target: CompactionTarget;
  /** true when the store is within goal (noop) or the pass actually shrank. */
  consolidated: boolean;
  /** true when nothing needed shrinking — zero LLM cost. */
  noop: boolean;
  error?: string;
}

export interface ScopedCompactionResult {
  /** true when every claimed target pass completed (no-ops count as complete). */
  consolidated: boolean;
  /** the tenant has no completion capability — precondition miss, not failure. */
  skipped?: "no-completion";
  /** a background review/flush/correction holds the gate — retry later. */
  deferred?: boolean;
  targets: readonly CompactionTargetResult[];
}

export interface ScopedCompactionOptions {
  complete?: MemoryCompletion;
  gate: BackgroundGate;
  /** the layered facade (routes capacity reads per target, entry.ts store). */
  store: MemoryStore;
  /** handle teardown check between passes (dispose/erase set it). */
  isDisposed: () => boolean;
  signal?: AbortSignal;
}

async function passOneTarget(
  options: ScopedCompactionOptions,
  target: CompactionTarget,
): Promise<CompactionTargetResult> {
  if (options.isDisposed()) {
    return { target, consolidated: false, noop: false, error: "disposed" };
  }
  if (options.signal?.aborted) {
    return { target, consolidated: false, noop: false, error: "aborted" };
  }
  const usage = options.store.capacityUsage(target);
  const goal = options.store.capacityGoal(target);
  if (usage <= goal) {
    return { target, consolidated: true, noop: true };
  }
  // consolidateViaCompletion carries requireShrink: a plan that does not
  // shrink is rejected and the store stays untouched (P0 test). One call
  // either converges or reports; re-calling compact() resumes from the
  // on-disk state — chunking the long tail is a mechanism decision that
  // stays inside this module (MEMORY-COMPACT-DESIGN.md R2).
  const result: ConsolidationResult = await consolidateViaCompletion(options.store, {
    target,
    complete: options.complete!,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return {
    target,
    consolidated: result.consolidated,
    noop: false,
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

/**
 * One bounded compaction pass over the tenant's memory + failure stores.
 * Sequential under a single gate claim: a memory pass that shrinks may make
 * the failure pass a no-op under the same tenant budget, and interleaving
 * two completion chains through one gate would defeat its purpose.
 */
export async function runScopedCompaction(
  options: ScopedCompactionOptions,
): Promise<ScopedCompactionResult> {
  if (options.complete === undefined) {
    return { consolidated: false, skipped: "no-completion", targets: [] };
  }
  if (!options.gate.tryStart()) {
    return { consolidated: false, deferred: true, targets: [] };
  }
  try {
    const targets: CompactionTargetResult[] = [];
    for (const target of ["memory", "failure"] as const) {
      targets.push(await passOneTarget(options, target));
    }
    return {
      consolidated: targets.every((t) => t.consolidated),
      targets,
    };
  } finally {
    options.gate.finish();
  }
}
