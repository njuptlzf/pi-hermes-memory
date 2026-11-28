/**
 * Per-tenant reentry guard for the scoped history backfill (backlog #18).
 *
 * Mirrors upstream's `sessionBackfillState.inProgress`
 * (`handlers/session-backfill.ts:83,103,118`), but SCOPED per tenant: a module
 * global would let one tenant's pass starve another's, which the multi-tenant
 * model forbids (AGENTS.md scoped rules).
 *
 * Two callers share one gate per handle:
 *  - the open-time incremental pass (`startScopedHistoryBackfill`) claims it
 *    NON-priority: when a pass is already queued it DROPS itself (returns null)
 *    — lossless, because the in-flight pass writes the same cursor rows and the
 *    cursor-equality skip makes the next open cheap regardless;
 *  - a manual full reindex (`reindexScopedHistory`) claims it PRIORITY: it never
 *    drops, it chains after whatever is running. An explicit user action must be
 *    honored; "priority" governs the guarantee (never dropped), not the order
 *    (a fire-and-forget open pass already walking the port runs first, which is
 *    strictly cheaper than restarting the walk).
 *
 * Deviations from SESSION-REINDEX-DESIGN.md §2.3 (both equivalence-preserving,
 * recorded here so the record and code never silently diverge):
 *  - `run` is generic over the pass result instead of importing
 *    `SessionBackfillStats`; that keeps this module import-free and breaks a
 *    would-be type cycle with session-search.ts (which owns the stats type and
 *    takes the gate as a parameter).
 *  - no `ready` seeding / `current()` promise: readiness is owned by the
 *    callers — `startScopedHistoryBackfill` already awaits `isReady` inside its
 *    pass, and `handle.reindexSessions()` awaits `ready` before calling
 *    `reindexScopedHistory`. Chaining both onto the same `tail` therefore waits
 *    for disk load exactly as the record describes, without a second ready hook.
 */

export interface ScopedBackfillGate {
  /**
   * Queue a pass. Non-priority returns `null` when the gate is busy (dropped);
   * priority always queues and resolves with the pass result.
   */
  run<T>(pass: () => Promise<T>, opts?: { priority?: boolean }): Promise<T | null>;
  /** Passes currently queued or running. Observability / test seam. */
  pending(): number;
}

const swallow = (): void => {};

export function createScopedBackfillGate(): ScopedBackfillGate {
  // `tail` carries only settled void so a rejected pass never wedges the queue.
  let tail: Promise<void> = Promise.resolve();
  let queued = 0;

  return {
    run<T>(pass: () => Promise<T>, opts: { priority?: boolean } = {}): Promise<T | null> {
      if (!opts.priority && queued > 0) return Promise.resolve(null);
      queued++;
      // Invoke the pass exactly once; its result reaches the caller through
      // `started`, while `tail` only needs to know the slot freed.
      const started = tail.then(pass, pass);
      const chained = started.then(swallow, swallow);
      tail = chained;
      chained.then(
        () => { queued -= 1; },
        () => { queued -= 1; },
      );
      return started;
    },
    pending() {
      return queued;
    },
  };
}
