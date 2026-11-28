# Session reindex design — manual full-reindex surface (backlog #18)

> Fork-owned file. Design record per `UPSTREAM-MAPPING.md` §3.2 — an executable
> contract, not a sketch. Implements backlog **#18** (`/memory-index-sessions`
> equivalent): upstream's *manual full reindex* path, which is structurally
> distinct from the auto/incremental path already wired as
> `startScopedHistoryBackfill` (`SESSION-BACKFILL-DESIGN.md`). Status:
> **design only, not scheduled** — verdict history in `TASKS.md` #18 (corrected
> 2026-11-27, PR #49: the two upstream paths are not redundant with each
> other, and the row's old "nothing to index" blocker is void).
>
> Per `WIRING-CONTRACT.md` §5, host-side wiring (agent-chat call surface,
> protocol fields) is NOT described here; §6 states only what the fork needs
> the host to do, and the host-side record lives in the agent-chat repo.

## 0. What this buys

Upstream has **two** session-indexing paths and the scoped adapter today has
one of them:

| Upstream path | Mechanism | Scoped today |
| --- | --- | --- |
| Auto/incremental backfill | `scheduleSessionBackfill` (`src/handlers/session-backfill.ts:70-127`), started at `session_start` (`src/index.ts:266`): stat-only preflight `needsBackfill` (`src/store/session-indexer.ts:539-605`) → `indexChangedSessions` (`:451-509`), newest-first, **cap 50 per startup** | **wired**: `startScopedHistoryBackfill` (`src/scoped/session-search.ts:351-361`), cursor=`updatedAt`, `BACKFILL_SESSIONS_PER_OPEN = 50` (`:249-251`) |
| Manual full reindex | `/memory-index-sessions` command (`src/handlers/index-sessions.ts:32-106`) → `indexAllSessions` (`src/store/session-indexer.ts:407-442`), **unbounded**, honors retention (`:55-57`) | **absent** |

The manual path is not legacy: no `@deprecated` marker anywhere, and upstream
still maintains it (CHANGELOG 0.7.21 custom session dir fix; 0.11.0
`sessionIndexExclude` explicitly applied to "the startup backfill preflight,
the deferred backfill, live indexing, and `/memory-index-sessions`"). What was
replaced in 0.7.19 was the *startup* full-scan behavior (multi-second stalls),
not the user-triggered command.

The user need survives the tenant model verbatim: with a 50-per-open cap and
newest-first ordering (`SESSION-BACKFILL-DESIGN.md` B8), a host with hundreds
of saved sessions converges only after many opens — or a reindex pass was
interrupted by budget/dispose and the user wants it finished now. The fork
answer is a **handle method the host calls** (TUI `registerCommand` is inert
in rpc — the same conclusion as rows #9/#12), not an agent tool: upstream
models it as a user/admin action, it is a bulk-write operation whose result
(`sessionsIndexed`/`errors`) has no agent-consumable decision to drive.

## 1. Facts (verified against `f0e32f8` via the cbm graph, 2026-11-27)

1. **`indexAllSessions` is file-rooted and cannot be reused.** It walks
   `getSessionFiles(sessionsDir, ...)` (`session-indexer.ts:407-416`); a tenant
   has no sessions directory — the same forced constraint that made the auto
   path use the `history` port shim (`SESSION-BACKFILL-DESIGN.md` §3). The
   tenant-equivalent of "re-read everything" is: iterate the **full**
   `history.list()` and `load()` each session, bypassing the cursor's
   equality-skip.
2. **Reusing `indexCurrentSession` keeps reindex idempotent.** The port path
   already indexes through `indexCurrentSession` → `indexSessionOnce` with
   `INSERT OR IGNORE` on stable pi entry ids
   (`SESSION-BACKFILL-DESIGN.md` §1 fact 2, proven by
   `tests/store/session-indexer.test.ts:679-712`). Re-loading an unchanged
   session after a cursor bypass therefore writes zero duplicate rows; the
   cost is one `load()` + one parse per session.
3. **The cursor is what makes auto-backfill cheap — and what a naive reindex
   would silently destroy.** `backfillScopedHistoryOnce`
   (`src/scoped/session-search.ts:294-344`) skips a session iff
   `cursor[s.sessionId] === s.updatedAt` (`:309`), and P6's retention design
   depends on exactly this: a pruned-but-still-listed session stays absent
   *only because its cursor entry survives*
   (`P6-SESSION-MAINTENANCE-DESIGN.md` §1 fact 7, §2.3). Therefore:
   - **Reindex must NOT delete the cursor.** It *bypasses* the equality-skip
     for the duration of one pass and then rewrites cursor entries to the
     observed `updatedAt` values, preserving every future incremental skip.
   - **A bypass without a retention guard re-adds pruned sessions.** Today's
     auto    path has no time filter of its own — it relies on the cursor skip to
   keep pruned rows absent. Once the skip is bypassed, an out-of-window
   session with a surviving `history.list()` entry would be loaded and
   re-inserted, undoing `runScopedSessionRetention` — the silent-retention
   breach C6 exists to prevent. Upstream's manual command has the same
   guard for the same reason (`index-sessions.ts:54-56`: "a manual reindex
   must not re-add the expired sessions the auto pruning just deleted",
   passing `retentionCutoffMs(config.sessionRetentionDays)` into
   `indexAllSessions`, which skips files whose mtime is out of window —
   `session-indexer.ts:421-423`, `isWithinRetention` defined at `:70`).
4. **`retentionCutoffMs` is pure and reusable.** `(days) => days > 0 ?
   Date.now() - days * 86_400_000 : 0` (`src/store/session-indexer.ts:656-659`).
   The fork guard must map it onto the port's time signal: `updatedAt` is an
   ISO string (`history-types.ts:16-18`), so eligibility is
   `retentionCutoffMs === 0 || Date.parse(s.updatedAt) >= cutoffMs`. Note the
   upstream/auto-path equivalence caveat in R5.
5. **Reconcile semantics stay correct in a full pass.** The deletion set is
   `cursor keys − list() ids − liveId` (`session-search.ts:330-341`). It is
   computed from the port's authoritative list and is independent of the
   equality-skip, so bypassing the skip neither widens nor narrows it. Test 8c
   pins this.
6. **There is no reentry guard today — and adding a trigger surface creates
   one need.** `startScopedHistoryBackfill` is fire-and-forget at open
   (`entry.ts:399-410`, `session-search.ts:351-361`) with no
   in-progress state; today a second pass can only come from another mount.
   Once `reindexSessions()` exists, a host can call it while the open-time
   pass is still walking (both await `ready`, both loop over
   `history.list()`). Upstream prevents double-walks with
   `state.inProgress` (`session-backfill.ts:75,83,103,118`); the fork
   needs the equivalent, scoped per tenant (§2.3). Two concurrent passes would
   interleave cursor writes — the last `writeBackfillCursor` wins and can
   regress entries the other pass had just advanced, which re-triggers
   harmless-but-wasteful re-loads, and in the full-pass case can re-add
   between the pass's own retention check and a concurrent incremental
   writer. Serialize; do not dedupe by "cancel the running pass".
7. **The result shape already exists upstream.** `BulkIndexResult`
   (`src/store/session-indexer.ts:21-36`): `sessionsProcessed/Indexed/Skipped`,
   `messagesIndexed`, `errors[]`, `reachedLimit?`, `expiredSkipped?`. The
   fork's full-pass returns the same field names (fork-owned mirror type, no
   import of upstream internals is required — it is already same-repo, so the
   real constraint is the opposite: **reuse the upstream type**, do not
   re-derive a lookalike). `reachedLimit` is meaningful only for the capped
   path; a full pass reports `false`/absent — or the loop aborts on dispose,
   which gets its own flag (§2.2).
8. **The handle is the natural host seam.** `ScopedHermesHandle`
   (`entry.ts:193-218`) already exposes non-tool operations
   (`promptSection()`, `metrics()`, `erase()`, `mount()`); `provider.open()`
   forwards exactly those into `ProviderSession`
   (`src/scoped/provider.ts:84-94`, `:148-159`) and the descriptor carries
   capability booleans (`:104-114`, value at `:127`). A new optional
   `reindexSessions` on `ProviderSession` + `capabilities.sessionReindex`
   follows the established shape; per C6, hosts warn on a capability they
   cannot get instead of silently no-op'ing.

## 2. Call chain — exact code shapes

### 2.1 New: `reindexScopedHistoryOnce` — the full pass

Lives in `src/scoped/session-search.ts` beside the incremental pass and
**wraps** it, so the shim, header validation (B6), corrupt-payload handling
and reconcile stay single-sourced. The incremental function gains two
internal options (fork-owned module; no upstream file touched, no
`divergences.json` row — `session-search.ts` is already registered, extend
its `change` text):

```ts
// session-search.ts
interface BackfillPassOptions {
  /** full = bypass the cursor equality-skip for one pass, unbounded budget. */
  mode?: "incremental" | "full";
  /** ms cutoff from retentionCutoffMs(config.sessionRetentionDays); 0 = off. */
  retentionCutoffMs?: number;
  isDisposed?: () => boolean;            // existing 5th param, now threaded on every iteration (already true today)
}

export async function backfillScopedHistoryOnce(
  dbManager: DatabaseManager,
  history: MemoryHistoryPort,
  currentSessionId: () => string | null,
  isDisposed: () => boolean = () => false,
  options: BackfillPassOptions = {},     // NEW, defaults keep §today behavior exactly
): Promise<SessionBackfillStats>         // NEW return type, see 2.2
```

Loop-shape changes (diff against `:294-344`):

```
for (const s of sessions) {
  if (isDisposed()) return stats(aborted: true);
  if (mode === "incremental" && budget++ >= BACKFILL_SESSIONS_PER_OPEN) { stats.reachedLimit = true; break; }
  if (mode === "full" && cutoff > 0 && !isWithinRetentionMs(Date.parse(s.updatedAt), cutoff)) {
    stats.expiredSkipped++; continue;                    // fact 3: never re-add pruned
  }
  if (mode === "incremental" && cursor[s.sessionId] === s.updatedAt) continue;   // existing skip, now incremental-only
  ... existing load/validHeader/indexCurrentSession(cursor[s.sessionId] = s.updatedAt) unchanged ...
}
... existing reconcile + writeBackfillCursor unchanged (facts 3 and 5) ...
```

`isWithinRetentionMs` is a 3-line fork-owned helper
(`cutoff <= 0 || value >= cutoff`) mirroring the semantics of upstream's
private mtime-based `isWithinRetention` (`session-indexer.ts:70`, applied in
`indexAllSessions` at `:421` and in `indexChangedSessions` at `:470`); the
numeric comparison is identical, only the signal source differs (fact 4's
caveat R5). `indexCurrentSession(dbManager, snapshot)` returns an `IndexResult`
with a `skipped` flag (`session-indexer.ts:251`, `indexSessionOnce` at
`:97-111` with `INSERT OR IGNORE` at `:104,:109`), which the stats mapping in
§2.2 uses.

**Cursor discipline in full mode (the load-bearing part):** a `continue` in
full mode must NOT `delete cursor[id]` — entries for out-of-window or
unreadable sessions stay at their last known `updatedAt` so the *incremental*
skip still works next open. Only sessions actually (re)indexed get their
entry advanced, exactly as today. `writeBackfillCursor` then persists a
cursor that is a strict superset improvement — no invariant is broken for
P6 §2.3's prune/reindex interplay.

### 2.2 New exported surface — handle method + stats

```ts
// session-search.ts
export interface SessionBackfillStats {
  sessionsProcessed: number;
  sessionsIndexed: number;
  sessionsSkipped: number;      // incremental mode: cursor-equal
  expiredSkipped: number;       // full mode only, matches BulkIndexResult.expiredSkipped
  messagesIndexed: number;
  errors: string[];
  reachedLimit: boolean;        // false for a completed full pass
  aborted: boolean;             // disposed mid-pass
}

export function reindexScopedHistory(
  dbManager: DatabaseManager,
  history: MemoryHistoryPort,
  currentSessionId: () => string | null,
  retentionCutoffMs: number,
  gate: ScopedBackfillGate,     // §2.3
  isDisposed: () => boolean,
): Promise<SessionBackfillStats>  // awaits ready itself? No — see gate
```

Stats counts come from `indexCurrentSession`'s own result
(`session-indexer.ts:104-111` path already returns skipped/indexed — the same
source the tests use today; if a field is unavailable it is derived from the
per-session loop, not re-read from SQL). `SessionBackfillStats` is
structurally compatible with `BulkIndexResult` (fact 7) and the `reindex*`
fields are documented in the tool-free `README`-style block comment only —
this is not an agent-facing surface.

`ScopedHermesHandle` gains (entry.ts `:193-218`):

```ts
/** One-shot full reindex of the tenant's session mirror (backlog #18).
 *  No-op rejection ("session-search not enabled" / "history port absent")
 *  when the feature is not active; serialized against the open-time pass
 *  via the shared gate; honors config.sessionRetentionDays. */
reindexSessions(): Promise<SessionBackfillStats>;
```

Implementation at `openWithRoots`: read `retentionCutoffMs` from
`config.sessionRetentionDays` **at call time** (not mount time — a tenant
opened with retention 0 and later reconfigured still prunes/reindexes
correctly on the next call), and call `reindexScopedHistory(...)` through the
same gate the mount-time kickoff uses.

### 2.3 `ScopedBackfillGate` — the reentry guard (fact 6)

New fork-owned module `src/scoped/backfill-gate.ts`:

```ts
/** Per-tenant: at most one backfill pass walks the port at a time.
 *  Mirrors upstream's sessionBackfillState.inProgress
 *  (handlers/session-backfill.ts:83,103,118), but tenant-scoped — a module
 *  global would let one tenant starve another, which the multi-tenant
 *  model forbids (AGENTS.md scoped rules). */
export function createScopedBackfillGate(ready: Promise<void>): {
  run(pass: () => Promise<SessionBackfillStats>, opts?: { priority?: boolean }): Promise<SessionBackfillStats | null>;
  current(): Promise<void> | null;
};
```

- `startScopedHistoryBackfill` (mount path) becomes `gate.run(() =>
  backfillScopedHistoryOnce(...))`; returns `null` silently when the gate is
  busy (today the situation cannot occur; tomorrow it means "a reindex is
  already walking — its cursor writes cover what the open pass would do", so
  dropping the incremental pass is safe, not lossy).
- `reindexSessions()` calls `gate.run(fullPass, { priority: true })`:
  if a pass is in flight, the reindex **chains after it** (awaits
  `current()` then runs) rather than dropping or cancelling — an explicit
  user action outranks a fire-and-forget pass in *guarantee*, not in *order*.
- `ready` stays inside each pass (as today: `startScopedHistoryBackfill`
  awaits `ready` before calling `backfillScopedHistoryOnce`,
  `session-search.ts:351-361`); the gate chains on top. A reindex called
  before open completes waits for `ready` through the same first-in-queue
  pass's promise chain — the gate's initial `current()` is seeded from
  `ready.then(...)` at open when the mount kickoff is armed; when it is not
  armed (no `history`), `reindexSessions()` rejects with a stable message,
  matching the fact that without a port there is nothing to reindex.

### 2.4 Provider surface (fork side only)

`ProviderSession` (`provider.ts:84-94`) gains the optional forwarding
method, and capabilities gains the boolean (mirroring the
`dataRetention` precedent, fact 8):

```ts
interface ScopedHermesProviderCapabilities {
  readonly sharedProfile?: boolean;
  readonly dataRetention?: boolean;
  /** true = honours reindexSessions(): a full one-shot rebuild of the
   *  per-scope session mirror from ctx.history, retention-guarded. */
  readonly sessionReindex?: boolean;
}
```

`open()` forwards `reindexSessions: () => tenant.reindexSessions()` into the
returned session object (`provider.ts:148-159`). **Shape mapping (cross-check
2026-11-28):** the handle returns `SessionBackfillStats`, but the host port
(`记忆维护动作端口设计稿.md` §2.2) declares `MaintenanceResult` — the host record
owns the port shape, so the provider forward maps it:
`{ affected: stats.sessionsIndexed, errors: stats.errors, ...(stats.aborted ? { deferred: true } : {}) }`
(the per-target/processing detail stays on the handle method for direct users).
`PROVIDER_VERSION` is NOT bumped here (that is the release slice's job, AGENTS.md Releasing).

Host side (agent-chat) — NOT specified beyond this pointer per
`WIRING-CONTRACT.md` §5: the `MemoryProvider` protocol needs the optional
method + a call surface (admin action / HTTP endpoint) and the mismatch
warning pattern (like `dataRetention`). Until that lands, direct
`openScopedHermesMemory` users (and tests) get the feature end to end —
same staged wiring as retention's §6/§7 split in `P6-SESSION-MAINTENANCE-DESIGN.md`.

## 3. Impact surface — every file and every caller

| File | Change | Ownership |
| --- | --- | --- |
| `src/scoped/session-search.ts` | `BackfillPassOptions` + stats return on `backfillScopedHistoryOnce`; `reindexScopedHistory`; `isWithinRetentionMs`; `SessionBackfillStats` | fork-owned (already in `divergences.json` — extend `change` text, no new row) |
| `src/scoped/backfill-gate.ts` | **new** `createScopedBackfillGate` | fork-owned (new `divergences.json` row per gate rules) |
| `src/scoped/entry.ts` | handle gains `reindexSessions()`; mount kickoff routes through gate; gate constructed in `openWithRoots` next to the existing kickoff (`entry.ts:394-410`) | fork-owned |
| `src/scoped/provider.ts` | `capabilities.sessionReindex`; `ProviderSession.reindexSessions?`; forward at `:148-159` | fork-owned |
| `tests/scoped/session-reindex.test.ts` | **new**: §5 | fork-owned |
| `tests/scoped/session-backfill.test.ts` | existing cases must stay green **unmodified** (default options = today's behavior); a mechanical `void` → stats return-type widening only if the test consumes return values (it does not today) | fork-owned |
| `docs/fork/TASKS.md` | #18 pointer to this record | fork-owned |
| `docs/fork/SESSION-REINDEX-DESIGN.md` | this record | fork-owned |

**Upstream files: none modified.** `indexAllSessions`, `indexChangedSessions`,
`needsBackfill`, `BulkIndexResult`, `retentionCutoffMs`, `indexCurrentSession`
are import-called only (imports read upstream; they do not modify it —
AGENTS.md). No new `divergences.json` row beyond the gate file + the
session-search `change`-text extension.

**Callers of every changed signature — enumerated:**
`backfillScopedHistoryOnce` has exactly two callers in the graph
(`startScopedHistoryBackfill`; test `session-backfill.test.ts` reaches it via
`startScopedHistoryBackfill` only — `trace_path inbound`, verified 2026-11-27),
so the options/return widening is compile-visible at one site.
`startScopedHistoryBackfill` one caller (`entry.ts:406`).
`openScopedHermesMemory` — handle interface widened additively, all 12 graph
callers are tests or provider; no positional-destructuring callers exist.
`provider.open()` — additive optional field; agent-chat's consumer
(`session.ts`) ignores unknown members structurally, no host-side change
required to load the new provider.

## 4. Risks

| ID | Risk | Decision / mitigation |
| --- | --- | --- |
| R1 | **Default behavior change:** none for existing paths — `mode` defaults to `"incremental"` and the budget/cursor/reconcile lines execute exactly as today. The return-type widening (`void` → `SessionBackfillStats`) is source-compatible for the fire-and-forget callers (`void`-operator sites unaffected). | Align + document; §3 caller enumeration proves the surface is 1 production site. |
| R2 | **Pruned-session resurrection** — the failure fact 3 describes: bypass without retention guard silently un-prunes. | Guard mandatory in full mode (`expiredSkipped` counted); test 8a pins it *with retention enabled*, mirroring upstream `index-sessions.ts:55-57` and P6 §2.3's interlock. This is the load-bearing risk of the whole slice. |
| R3 | **Concurrent passes corrupt cursor state** (fact 6). | `ScopedBackfillGate` serializes per tenant; reindex chains, open pass drops (lossless by cursor-skip argument, §2.3). Test 8e drives both. |
| R4 | **Cost surprise:** full pass = `list()` size × (`load()` + parse). A 5 000-session tenant could hold the gate for minutes. | Accepted + bounded by the caller's own lifetime: per-iteration `isDisposed()` (existing B4 pattern) and the pass can be abandoned mid-way; cursor entries already written persist so a next call resumes incrementally-ish. No internal time/size cap — the upstream command has none either (its whole point is unbounded); hosts that need budgets use `history.list()`'s own ordering. Document in handle JSDoc. |
| R5 | **Retention signal mismatch:** prune uses `started_at`; the port summary exposes only `updatedAt` (fact 4). A session `started_at < cutoff ≤ updatedAt` is pruned today (P6 R5) — and now re-added by a full pass (still active, updatedAt fresh) instead of staying absent. | **Accept, and state it as a semantic:** reindex re-adds a session the user has *touched inside the window* — matching upstream's own file-mtime guard for the same case. Document in TASKS #18 note + handle JSDoc ("retrievable" = touched within window). Not drift: there is no tenant-side `started_at` available before `load()`, and pre-filtering via `load()` defeats R2's cheapness. |
| R6 | **Corrupt `updatedAt`** (`Date.parse → NaN`): NaN comparison is false → would skip a live session. | Treat NaN as "unknown age → reindex it" (conservative toward recall, never toward re-adding a *known-expired* session); test 8d. |
| R7 | **`erase()`/`dispose()` mid-reindex** races the gate. | `isDisposed()` is the existing `dbClosed` closure (`entry.ts:338`; set by `dispose`/`erase` at `:577,:594`; passed at the kickoff `:406-409`); stats come back `aborted:true`; no writes land after `dbClosed` because `indexCurrentSession` runs under `withCorruptionRecovery`'s closed guard (precedent: P6 R6). |

## 5. Tests — `tests/scoped/session-reindex.test.ts`

Fake port shaped like `tests/scoped/session-backfill.test.ts` (scripted
list/load, spy counters), real `DatabaseManager` in temp dir. Anchors use
**relative** times (`now-6h` etc. per the 2026-11-27 time-bomb lesson).

1. Full pass reindexes cursor-equal sessions (spy: `load` called for every
   in-window id despite cursor; row counts unchanged thanks to `INSERT OR
   IGNORE` — fact 2).
2. Second consecutive reindex is idempotent on rows (zero duplicate messages).
3. Cursor rewritten: after a full pass, an incremental pass next open makes
   0 `load()` calls (skip property survives — fact 3's non-deletion rule).
4. **(R2 core)** retention `days=1`: session with `updatedAt = now-7d`,
   already pruned, still listed → reindex leaves it absent; `expiredSkipped=1`;
   `searchSessions` for its verbatim text still misses.
5. **(R3)** reindex started while open-time pass in flight (deferred
   `list()`): second pass chains, no interleaved loads (spy timeline),
   gate.current resolves in order.
6. No `history` port / `sessionSearchEnabled=false`: `reindexSessions()`
   rejects with stable message; provider method absent behavior defined
   (`sessionReindex` capability still true only when the wiring exists at
   open — assert descriptor vs actual call).
7. `dispose()` mid-pass: `aborted:true`, no post-close writes (mirrors
   existing case 9 pattern).
8. NaN `updatedAt`: session reindexed, not skipped (R6).
9. Reconcile inside a full pass still deletes absent-from-list ids and
   protects `currentSessionId` (fact 5).
10. Descriptor: `capabilities.sessionReindex === true` (provider.test.ts
    pattern, like `dataRetention`).

## 6. Ship order

1. This record merged (design-only; `TASKS.md` #18 gains the pointer, status
   stays 延后 pending the host call surface).
2. Fork slice (gate + full pass + handle + provider + tests) when scheduled —
   #18 becomes fully answerable *inside the fork* except for the host trigger.
3. Host slice in **agent-chat's repo** (protocol optional method + call
   surface + capability warning): separate design record there, mirroring the
   P6 §7 retention split (`policy.dataRetentionDays` precedent — fork lands
   first, host contract follows, conformance asserts declaration→ctx
   crossing only, never provider internals).
4. Release + dist-tag steps unchanged (AGENTS.md Releasing).

## 7. Cross-references checked (after writing)

| Claim | Source | Verified |
| --- | --- | --- |
| two upstream paths, non-redundant, manual command maintained | `handlers/session-backfill.ts:70-127` vs `handlers/index-sessions.ts:32-106`; `indexAllSessions` call at `index-sessions.ts:65`; CHANGELOG.md:114,117,326 | yes (cbm graph, 2026-11-27) |
| upstream manual command honors retention | `index-sessions.ts:55-57` comment + `retentionCutoffMs` arg | yes |
| scoped auto path = cursor skip + 50 cap | `session-search.ts:294-344,249-251` | yes |
| prune interlock depends on surviving cursor | `P6-SESSION-MAINTENANCE-DESIGN.md` §1 fact 7, §2.3 | yes |
| `retentionCutoffMs` pure, 0 = off | `session-indexer.ts:656-659` | yes |
| idempotent re-index via INSERT OR IGNORE | `SESSION-BACKFILL-DESIGN.md` §1 fact 2 + `tests/store/session-indexer.test.ts:679-712` | yes |
| reconcile = cursor keys − listed − live | `session-search.ts:330-341` | yes |
| upstream reentry guard | `session-backfill.ts:75,83,103,118,148` | yes |
| BulkIndexResult shape | `session-indexer.ts:21-36` | yes |
| handle/provider seam + capability precedent | `entry.ts:193-218`; `provider.ts:84-94,104-114,127,136-159` | yes |
| `backfillScopedHistoryOnce` callers = {start, (transitively) entry} | cbm `trace_path(inbound, depth=2)`: 2 callers | yes |
| `sessionSearchEnabled` gate + kickoff site | `entry.ts:254,399-410` | yes |
| open-time `dbClosed` closure reused as isDisposed | `entry.ts:338,406-409,577,594` | yes |
| PROVIDER_VERSION = "0.11.0-scoped.9" (not bumped here) | `provider.ts:37` | yes |
| upstream full-scan mtime window check | `session-indexer.ts:421-429` (in `indexAllSessions`) | yes |
