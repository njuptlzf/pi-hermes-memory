# Session backfill design — scoped history port consumption (#3 completion, #4 backfill piece)

> **Status: implemented** (this slice — fork PR following this record; host
> port merged in agent-chat PR #17, squash `dcb07c3`). Implementation contract
> per `UPSTREAM-MAPPING.md` §3.2. Companion to
> `SESSION-SEARCH-DESIGN.md` (current-session slice, implemented in PRs
> #29/#30): that record's §9 named the host history port as the follow-up that
> makes #3 fully answer "what did we discuss last week". The port itself landed
> agent-chat-side (design `docs/design/记忆历史端口设计稿.md`, PR #17); **this
> record covers only the fork side**: consuming `ctx.history` to backfill past
> sessions of the scope into the tenant mirror.
>
> Non-goals here: prune/retention, `session_files` incremental metadata,
> ephemeral cleanup, the shutdown-from-JSONL path (the rest of backlog #4).

## 0. What this buys

After this slice, `session_search` answers questions about **any session of
this scope that the host has saved**, not just the live one: the tenant's
port is listed at open, changed sessions are re-read, and their messages are
indexed into the same `sessions`/`messages`/`message_fts` tables the live
turn indexer writes.

## 1. Facts (line numbers: hermes `751c08f`, agent-chat `9ce1a87` + PR branch `f64fcd3`)

1. **The port's entry shape is structurally identical to the live snapshot
   shape.** agent-chat's `exportHistory` = `[getHeader(), ...getEntries()]`
   (`session.ts:871-876`), and the port returns exactly that (`FileEntry[]`,
   first element `type:"session"`). Fork's `parseSessionManagerSnapshot`
   (`src/store/session-indexer.ts:233-249`) consumes
   `{ getHeader(): {id,timestamp,cwd} | null; getEntries(): unknown[] }`
   (:159-163) and its message filter (`parseMessageEntry` :213-231) reads
   only `type/id/timestamp/message.role/message.content`. So a loaded session
   is indexed by **shimming two accessor closures over the array** — zero new
   parsing, zero reuse of the file-based `parseSessionFile` (that one reads
   disk, which a tenant must not do).
2. **Idempotence is already proven on this exact path**: `indexCurrentSession`
   → `indexSessionOnce` uses `INSERT OR IGNORE` on both tables
   (:103-111) and message ids are pi entry ids, stable across save/restore.
   A session live-indexed today and backfill-indexed tomorrow lands once
   (`skipped:true`, `messagesIndexed:0`; `tests/store/session-indexer.test.ts:679-712`).
3. **Budget precedent**: upstream's file backfill stops at
   `maxFilesToIndex ?? 50` (`session-indexer.ts:457`); this record aligns the
   per-open session cap to that same default (§8 B1).
4. **Cursor storage**: `extension_metadata(key,value)` already exists in the
   tenant DB (`schema.ts:15-18`), read/written directly via
   `dbManager.getDb()` (`db.ts:1124,1171` show the pattern; no dedicated
   accessor API).
5. **Provider plumbing today**: fork `ProviderContext` has no history field
   (`src/scoped/provider.ts:34-60`); `open()` forwards
   `storageRoot/sharedRoot/complete/telemetry/completionLimits/tuning`
   (:106-113). Structural-mirror precedent for host types without importing
   protocol: `src/scoped/completion-types.ts` (header: "the fork deliberately
   does NOT import @njuptlzf/agent-chat-protocol").
6. **Mount gate**: `sessionSearchEnabled` (`entry.ts:226`) already gates tool +
   live index (:463-466); backfill belongs under the same gate — without the
   tool there is nothing to search.
7. **Host key axis**: the port is keyed `(userId, qual)` and `list()` is the
   authoritative full set (host design §2.2/H3; port aggregates past the
   store's LIMIT 50). The fork must trust `list()` as complete.

## 2. Option surface and full call chain

**Additive, fork-owned only. Zero upstream files.** `divergences.json` gains
one row per new fork-owned file as the gate requires (this design record;
implementation adds `history-types.ts` + the test file rows), mirroring how
#27/#29 registered theirs. The two existing session-search rows may get their
`change` text extended — registry description, not new rows.

### 2.1 New shim types — `src/scoped/history-types.ts`

```ts
/**
 * Structural mirror of the host's `MemoryHistoryPort` / `MemorySessionSummary`
 * (agent-chat `packages/protocol/src/memory-provider.ts`, PR #17). The fork
 * does NOT import the protocol package — host-neutral, same precedent as
 * completion-types.ts. Keep in sync; the port is optional everywhere, a host
 * without it behaves exactly like before this slice.
 */
export interface MemorySessionSummary {
  readonly sessionId: string;
  readonly updatedAt: string;
}
export interface MemoryHistoryPort {
  list(): Promise<readonly MemorySessionSummary[]>;
  load(sessionId: string): Promise<readonly unknown[] | undefined>;
}
```

`load` returning `readonly unknown[]` is deliberately weaker than the host's
`MemorySessionEntry[]` — the fork's consumer only passes elements to
`parseMessageEntry`'s structural filter, which already accepts `unknown`
(`session-indexer.ts:213`). Host's richer type satisfies it structurally.

### 2.2 Value flow

```
host: createProductSession opts.historyStore → ctx.history (agent-chat PR #17)
  → provider.open(ctx): tenant = openScopedHermesMemory({ ..., history: ctx.history })
  → entry.openWithRoots(options):
      if (sessionSearchEnabled && options.history) {
        startScopedHistoryBackfill(dbManager, options.history, ready, () => currentSessionId);
      }
  → session-search.ts (extended):
      ready.then(() => backfillOnce(...))   // fire-and-forget, never awaited by mount
        cursor = readCursor(dbManager)                        // extension_metadata JSON
        sessions = await history.list()                       // authoritative, newest first
        budget = BACKFILL_SESSIONS_PER_OPEN (50, §8 B1)
        for (const s of sessions) {
          if (disposed()) return;                             // §8 B4
          if (budget++ >= 50) break;                          // rest waits for next open
          if (cursor[s.sessionId] === s.updatedAt) continue;  // unchanged
          const entries = await history.load(s.sessionId);    // undefined → skip, retry next open
          if (!entries) continue;
          const header = entries.find(e => e.type === "session");
          if (!validHeader(header)) { cursor[s.sessionId] = s.updatedAt; continue; } // §8 B6
          const snapshot = { getHeader: () => header, getEntries: () => entries.filter(e => e !== header) };
          dbManager.withCorruptionRecovery(() => indexCurrentSession(dbManager, snapshot));
          cursor[s.sessionId] = s.updatedAt;
        }
        reconcileDeleted(dbManager, cursor, new Set(sessions.map(id)), currentSessionId); // §8 B5
        writeCursor(dbManager, cursor);
      .catch(err => reportScopedIndexFailure(err))            // same best-effort channel
```

`currentSessionId` is read lazily from the handle's last live snapshot
(`turn_end` already receives `ctx.sessionManager.getHeader()`); before the
first turn it is `null` and reconcile simply has nothing to protect.

### 2.3 Cursor row

Single JSON blob, one read + one write per open (session count × ~50 bytes):

```
key   = "scoped_session_backfill"
value = { [sessionId]: updatedAt, ... }
```

Written with the existing pattern (`INSERT … ON CONFLICT(key) DO UPDATE SET
value = excluded.value`, cf. `db.ts:1171-1173`). Stale cursor entries for
sessions reconcile already deleted are dropped when the cursor is written.

### 2.4 reconcileDeleted (why it must not touch the live session)

Deletion set = cursor keys − list() ids. A resumed session keeps its
`header.id` (§1 fact 2), and the host may legitimately drop it from the
saved set while it is **live right now** (saved earlier, since deleted from
history). Deleting its mirror rows would silently amputate the current
session's searchable past — so `currentSessionId` is excluded from the
deletion set unconditionally; the live `turn_end` indexer would re-add it on
the next turn anyway, but we do not rely on that. Deletes run in one
transaction:

```sql
DELETE FROM messages WHERE session_id IN (…);
DELETE   FROM sessions WHERE        id  IN (…);
```

(shape proven by upstream `pruneEphemeralReviewSessions`,
`session-indexer.ts:316-317`; message_fts triggers `messages_ad`
(`schema.ts:64-66`) keep the FTS index in sync automatically).

## 3. Data source decision — why NOT `parseSessionFile`/`indexChangedSessions`

Upstream's bulk path is directory-based: `getSessionFiles(sessionsDir)` +
`parseSessionFile(path)` + `session_files` metadata
(`session-indexer.ts:451-509`). None of it is usable: there is no sessions
directory for a tenant, `AGENT_ROOT` is forbidden at import time, and
`session_files` bookkeeping tracks file mtime/size we never see. The port
gives entry arrays instead, and §1 fact 1 shows the array→snapshot shim
reaches the same `indexSession` through code the live path already runs.
Classification: **forced** (`AGENTS.md`: assumes a file root the tenant
replaces), recorded here; the shim lives in the fork-owned
`session-search.ts`, no upstream file changes.

## 4. Impact surface

| File | Change | Ownership |
| --- | --- | --- |
| `src/scoped/history-types.ts` | **new**: §2.1 shim | fork-owned |
| `src/scoped/provider.ts` | `ProviderContext.history?` + forward at open() (:106-113) | fork-owned |
| `src/scoped/entry.ts` | `ScopedHermesOptions.history?`; schedule backfill under `sessionSearchEnabled`; pass `disposed()`/current-id closures | fork-owned |
| `src/scoped/session-search.ts` | +`startScopedHistoryBackfill`, cursor read/write, reconcile helper | fork-owned (already registered; extend `change` text in divergences row) |
| `tests/scoped/session-backfill.test.ts` | **new**: §7 | fork-owned |
| `docs/fork/TASKS.md` | #3 note "cross-session done", #4 partial note | fork-owned |
| `docs/fork/SESSION-SEARCH-DESIGN.md` | §9 status line | fork-owned |

**Callers of changed signatures:** `openScopedHermesMemory(options)` —
signature widened by one optional field, no caller breaks (provider +
existing scoped tests pass `tuning` positionally in an object literal).
`provider.open(ctx)` — additive field, host-side structural typing, PR #17
already sends it. `indexCurrentSession(dbManager, snapshot)` — no change,
new call sites only (§6 of the sibling record already enumerated this).
No upstream file is modified; `divergences.json` gains no new row.

## 5. Cross-references checked

| Claim | Source | Checked |
| --- | --- | --- |
| port shape + authoritative full list | agent-chat PR #17 protocol §2.1 / design H3 | yes |
| exportHistory = header + entries | `session.ts:871-876` | yes |
| snapshot accessor shim suffices | `session-indexer.ts:159-163,233-249,213-231` | yes |
| entry ids stable across save/restore (idempotence) | live path + `tests/store/session-indexer.test.ts:679-712` | yes |
| cursor table + upsert pattern | `schema.ts:15-18`; `db.ts:1171-1173` | yes |
| delete shape + FTS trigger cleanup | `session-indexer.ts:316-317`; `schema.ts:64-66` | yes |
| budget precedent 50 | `session-indexer.ts:457` | yes |
| gate + mount line numbers | `entry.ts:226,463-466` (post #29/#30) | yes |
| provider forward site | `provider.ts:106-113` | yes |
| shim precedent | `completion-types.ts:1-8` | yes |

## 6. Design-record completeness notes (UPSTREAM-MAPPING §3.2)

- **Default-value changes:** none. `history` is absent today on every host
  path (PR #17 not yet consumed by agent-chat's own deployment until its
  server passes `historyStore` — that wiring IS in PR #17: both call sites).
  Fork behavior with no port = exactly current shipped behavior.
- **Counting/timing model changes:** none to review/flush; a new async
  open-time task is added, serialized against turns by single-threaded JS +
  synchronous better-sqlite3 transactions (§8 B2).

## 7. Tests — `tests/scoped/session-backfill.test.ts`

Fake port (scripted list/load), real `DatabaseManager` on temp dir, entry
arrays shaped like `exportHistory` output. Mount path: `openScopedHermesMemory({…,
history: fakePort})` then drive handlers.

1. **Backfill then search**: two past sessions in port → tool finds verbatim
   text from both; live `turn_end` session still indexes normally.
2. **Cursor skip**: second mount with same list → port.load called 0 times
   (spy count), no duplicate rows (stats unchanged).
3. **Changed session**: bump `updatedAt` + append entry → only that session
   reloads; message count grows by the new entry; old ids not duplicated.
4. **Deleted session (reconcile)**: drop id from list → rows gone from
   `sessions`+`messages`, FTS no longer hits, cursor pruned.
5. **Live-session protection**: deleted from list **but** already live-indexed
   this mount (current header id) → rows survive.
6. **Budget**: 60 sessions listed → at most 50 loads per open, cursor covers
   processed ones, remainder picked up next open.
7. **No port / port absent**: `history` omitted → no metadata row written,
   mount identical to #29 behavior.
8. **Host degradation**: `list()` rejects → mount unaffected, one noise-free
   `console.error` via the microtask channel; `load` returns undefined →
   session skipped, cursor not advanced for it.
9. **disposed abort**: fire backfill, call `handle.dispose()` mid-await
   (deferred port) → no closed-DB spam, task ends silently.
10. **Header validity**: entries without a valid session header → skipped,
    cursor advanced (B6), zero rows written.

## 8. Risks

| ID | Risk | Decision |
| --- | --- | --- |
| B1 | **Budget constant.** Upstream's per-run file cap is `maxFilesToIndex ?? 50` — a function default, not a config field (`MemoryConfig` has no backfill budget; port paging lives host-side). | Keep 50 as a named fork-owned constant `BACKFILL_SESSIONS_PER_OPEN = 50` with a comment pointing at `session-indexer.ts:457` as the aligned source. Not drift: there is no config field to read; the literal exists upstream too. A future config field would replace it. |
| B2 | **Concurrency with live indexing.** Backfill runs in `ready.then`, a turn can land mid-list-loop. | Safe by construction: better-sqlite3 statements are synchronous and `indexSessionOnce` is one transaction; JS never interleaves them. Same-session overlap just hits `INSERT OR IGNORE`. No lock needed; do not add one. |
| B3 | **Privacy of the port data.** History is user content; it flows into the tenant DB only. | Metrics never log content (AGENTS.md Security). Cursor stores ids+timestamps only. No cross-tenant path exists (port closure is host-side, PR #17). |
| B4 | **dispose mid-flight.** Long list loop + fast session teardown (agent-chat disposes when the HTTP session ends) → later loads hit the closed guard. | Check `disposed()` before each iteration (cheap closure); remaining sessions are simply picked up next open via cursor. Report through `reportScopedIndexFailure`'s skip-closed branch if a race still lands one write — it already tolerates that error. |
| B5 | **Reconcile deletes a resumed-but-current session** (§2.4). | Unconditional exclusion of `currentSessionId` + the cursor-map scoping (only ids the port itself backfilled are candidates). Live-indexed ids the port never knew about are structurally outside the deletion set. |
| B6 | **Corrupt/edge payloads**: `load` returning header-less or junk arrays. | Valid header required (`type:"session"` + id/cwd/timestamp — same check `parseSessionManagerSnapshot:235` makes); invalid → advance cursor anyway (don't retry garbage every open) and write nothing. |
| B7 | **Scale**: thousands of saved sessions → list loop is 50/open but the cursor JSON grows unbounded across opens. | Accepted for the slice: cursor rows are ids+ISO timestamps; 1k sessions ≈ 45 KB. Retention (#4) is the real bound; reconcile also prunes stale keys each open, so churn is bounded by live set + budget-remnants. |
| B8 | **Order**: `list()` newest-first means old unread sessions starve under active ones at 50/open. | Accepted: newest-first matches upstream (backfill order `reachedLimit` semantics, :497) and user recall questions skew recent. Document, do not paginate round-robin. |

## 9. Ship order

1. agent-chat PR #17 merges (port is null-safe for old providers).
2. This fork PR merges (port absent → no-op; host deployment then passes it).
3. Release bump (`0.11.0-scoped.8`) with both sides verified end to end in a
   live agent-chat session, per `docs/PUBLISHING.md` — separate decision.
