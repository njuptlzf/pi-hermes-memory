/**
 * Structural mirror of the host's `MemoryHistoryPort` / `MemorySessionSummary`
 * (agent-chat `packages/protocol/src/memory-provider.ts`, PR #17).
 *
 * The fork deliberately does NOT import `@njuptlzf/agent-chat-protocol` — it
 * must stay host-neutral and loadable by any host. TypeScript structural
 * typing means the host's port satisfies this shape without a shared import
 * (same precedent as `completion-types.ts`). Keep fields in sync.
 *
 * The port is optional everywhere: a host without history behaves exactly as
 * before session backfill landed.
 */

/** Host-side authoritative summary of one saved session. */
export interface MemorySessionSummary {
  readonly sessionId: string;
  /** ISO timestamp of the last host save; the per-session change cursor. */
  readonly updatedAt: string;
}

/**
 * Read-only view of this scope's saved sessions. The host welds userId+scope
 * into the closure; the provider has no cross-tenant call path.
 */
export interface MemoryHistoryPort {
  /**
   * Full authoritative set, newest first (the host aggregates internally past
   * its UI's page limit). Ids missing here are considered deleted by the
   * provider's reconcile step.
   */
  list(): Promise<readonly MemorySessionSummary[]>;
  /**
   * Raw session entries (`FileEntry[]` shape: header + entries). Returns
   * `undefined` for a missing/unreadable session — the host maps its own read
   * failures here so an unavailable session is "not yet indexable", not an
   * error the provider must recover from.
   */
  load(sessionId: string): Promise<readonly unknown[] | undefined>;
}
