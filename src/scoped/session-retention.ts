/**
 * Bounded session retention for a tenant mirror (#4 residual, P6 design).
 *
 * Why a scoped reimplementation: upstream runs `pruneOldSessions` from a CLI
 * startup hook (`src/index.ts:251`). A host-loaded provider never executes that
 * entry, so the call is restated here at the fork-owned mount boundary. The
 * engine function itself is reused unchanged — pure DB, no env/home/file/spawn.
 *
 * No cursor writes: the backfill's own skip rule (`session-search.ts:306-311`)
 * keeps a pruned-but-still-listed session from being re-indexed, and reconcile
 * (`:327-342`) deletes cursor entries only for ids gone from the port. Writing
 * a sentinel would make the equality check false and re-add the pruned session
 * — see P6-SESSION-MAINTENANCE-DESIGN.md §2.3.
 */

import type { DatabaseManager } from "../store/db.js";
import { pruneOldSessions } from "../store/session-indexer.js";
import { reportScopedIndexFailure } from "./session-search.js";

/**
 * Prune the tenant's `sessions`/`messages` mirror to the configured window.
 * Best-effort: a failure is observable through the same channel as a failed
 * index, never thrown out of the ready chain. A handle disposed mid-wait skips
 * the write entirely (no write into a released DB).
 */
export function runScopedSessionRetention(
  dbManager: DatabaseManager,
  retentionDays: number,
  isReady: Promise<void>,
  isDisposed: () => boolean,
): Promise<void> {
  return isReady
    .then(() => {
      if (isDisposed()) return;
      dbManager.withCorruptionRecovery(() => pruneOldSessions(dbManager, retentionDays));
    })
    .catch((error: unknown) => reportScopedIndexFailure(error));
}
