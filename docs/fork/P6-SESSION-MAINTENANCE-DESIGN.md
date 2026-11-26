# Session maintenance design — #4 recovery sidecar (D) + retention prune (A)

> Fork-owned file. Design record per `UPSTREAM-MAPPING.md` §3.2 — an executable
> contract, not a sketch. Implements the two #4残项 that have a tenant-safe
> equivalent (`WIRING-CONTRACT.md` §3.3): **D** = recovery sidecar maintenance,
> **A** = bounded session retention. Not in scope: `session_files` materialisation
> and orphan review-session cleanup — their capabilities are already covered by
> the backfill cursor / reconcile (see `SESSION-BACKFILL-DESIGN.md`, `TASKS.md` #4).
>
> Status: implemented 2026-11-26. Line numbers in §5 were re-verified against
> the post-implementation tree — the pre-implementation anchors for the `ready`
> chain and the backfill kickoff shifted by +1/+10 lines and are updated here.

## 0. What this buys

Two bounded housekeeping jobs run once per tenant open, both on data the tenant
already owns:

- **D — recovery sidecar maintenance.** A crash between the atomic write and the
  rename of a Markdown memory file leaves a sidecar that the next open should
  reconcile. `MemoryStore.maintainRecoveryFiles()` already does this; the layered
  store already delegates it to both roots (`layered-store.ts:58-59`) — but
  **nobody calls it** in the scoped path (grep: only the definition + the upstream
  `runRecoveryMaintenance`). Wiring the call means a tenant recovers its own
  sidecars on open without any host path or project root.
- **A — bounded retention.** The per-tenant `sessions`/`messages` mirror grows
  without limit, and the host's `list()` is authoritative-and-full: a session
  deleted on the mirror but still in history is re-indexed on the next open.
  A retention pass bounded by `sessionRetentionDays` caps the mirror; the
  existing backfill cursor already prevents a pruned-but-still-listed session
  from being re-indexed, so no new state is needed. Default `0` = disabled, so
  current behavior is unchanged.

## 1. Facts (verified against `b068180`)

1. **`maintainRecoveryFiles()` exists on both stores and is already delegated.**
   `createLayeredStore` returns a facade whose `maintainRecoveryFiles` awaits
   `scopeStore.maintainRecoveryFiles()` and `profileStore.maintainRecoveryFiles()`
   in parallel (`src/scoped/layered-store.ts:58-59`). The underlying method is
   `MemoryStore.maintainRecoveryFiles()` (`src/store/memory-store.ts:205-210`);
   it touches only sidecar files under the store's own `memoryDir`.
2. **No scoped caller exists.** Repo-wide grep for `maintainRecoveryFiles` yields
   only: the facade (`:58-59`), the engine method (`memory-store.ts:205`), and
   upstream's `runRecoveryMaintenance` (`recovery-maintenance.ts:59`). The
   scoped entry's `ready` chain (`entry.ts:346-362`) calls only
   `loadFromDisk()` + `seedSearchMirror()`.
3. **Upstream's wrapper is the forced part, not the method.** `runRecoveryMaintenance`
   (`recovery-maintenance.ts:52-66`) calls `listMemoryStoreDirs` (`:35-50`), which
   reads `projectsRoot` and constructs a fresh `MemoryStore({ memoryDir })` per
   directory — a project axis and a disk-root discovery the tenant model replaces.
   Calling the existing store instance's method avoids both.
4. **`pruneOldSessions` is a pure DB function.** `pruneOldSessions(dbManager,
   retentionDays)` (`session-indexer.ts:680-730`) only uses `dbManager.getDb()`;
   no env, no file, no spawn. Eligibility is `session_files.mtime_ms < cutoff` OR
   (`session_files.path IS NULL AND sessions.started_at < cutoff`). Scoped never
   writes `session_files`, so the fallback (`started_at`) is the live path.
5. **`started_at` is populated on every indexed session.** `indexSessionOnce`
   inserts `sessions.started_at = session.startedAt` (`session-indexer.ts:104-108`);
   the scoped backfill's header guard requires `timestamp` to be a non-empty
   string (`session-search.ts:279-286`) and passes it as the snapshot header, so
   `parseSessionManagerSnapshot` derives `startedAt` from it. Prune's fallback
   signal is therefore always present.
6. **Retention config already exists in the config object.** `sessionRetentionDays`
   is a real `MemoryConfig` field (`src/types.ts:142`, default at `config.ts:119`,
   validated at `config.ts:232-233`). Scoped builds `config` from
   `...defaultMemoryConfig()` and `...options.config` (`entry.ts:234-236`), so the
   field is reachable with **zero new type** — no tuning addition needed for this
   slice.
7. **The re-index hazard is real.** `backfillScopedHistoryOnce` loads any session
   whose `cursor[id] !== s.updatedAt` (`session-search.ts:306-311`). If a pruned
   id stays in `history.list()` but is gone from the mirror, its cursor entry is
   still equal to `updatedAt` — so it is *skipped*, not re-indexed — **only while
   its cursor entry survives**. Reconcile deletes cursor entries for ids absent
   from `list()` (`:330-342`); a pruned-but-still-listed id keeps its cursor entry,
   so it stays skipped. The correct order is therefore **prune first, then
   backfill**: prune removes the rows, the retained cursor entry suppresses
   re-index, and only a genuine `updatedAt` change re-adds the session.
8. **Both jobs are idempotent and best-effort.** `maintainRecoveryFiles` is
   safe to re-run (reconcile-style); `pruneOldSessions` returns zero on an empty
   eligible set. Neither may throw out of the ready chain — `ready` already has a
   catch that logs via `queueMicrotask` (`entry.ts:356-362`).

## 2. Call chain — exact code shapes

### 2.1 D — recovery sidecar call

Hook into the existing `ready` chain, next to `seedSearchMirror` (`entry.ts:346-362`):

```ts
const ready = Promise.all([scopeStore.loadFromDisk(), profileStore?.loadFromDisk() ?? Promise.resolve()])
  .then(async () => {
    seedSearchMirror();
    await store.maintainRecoveryFiles();   // NEW: facade → both roots
  })
  .catch((error: unknown) => { /* existing best-effort log */ });
```

`store` is the layered facade declared at `entry.ts:260-263` (or `scopeStore`
when `profileStore === null`). Calling the facade covers both roots with one
line; calling `scopeStore` directly would skip the shared profile's sidecars.
`await` keeps `ready` meaningful: `promptSection()` already `await ready`
(`entry.ts:404`), so a consumer that asks for the prompt after open sees a
reconciled store.

No new import: `store.maintainRecoveryFiles()` is on the `MemoryStore` type the
facade already returns. No host field, no config, no new option.

### 2.2 A — retention prune + cursor handoff

Retention needs the same "after load" slot, and must run **before** backfill
starts so a just-pruned row is not re-added in the same open.

New fork-owned module `src/scoped/session-retention.ts`:

```ts
import type { DatabaseManager } from "../store/db.js";
import { pruneOldSessions } from "../store/session-indexer.js";

/** Prune the tenant mirror to the configured window. No cursor writes: the
 *  backfill's own skip rule keeps a still-listed pruned session from returning. */
export function runScopedSessionRetention(
  dbManager: DatabaseManager,
  retentionDays: number,
  isReady: Promise<void>,
  isDisposed: () => boolean,
): Promise<void> { /* §2.3 */ }
```

Called from `openWithRoots` **before** the backfill kickoff
(`entry.ts:369-380`):

```ts
if (sessionSearchEnabled && options.history && (config.sessionRetentionDays ?? 0) > 0) {
  void runScopedSessionRetention(dbManager, config.sessionRetentionDays!, ready, () => dbClosed);
}
if (sessionSearchEnabled && options.history) {
  void startScopedHistoryBackfill(...);   // existing
}
```

Both await the same `ready`, so retention's synchronous prune completes before
backfill's first `await history.list()`. The guard keeps default `0` a strict
no-op — no async task, no DB write, no behavior change.

### 2.3 Why no cursor writes are needed — the load-bearing reasoning

This is the subtle part, and getting it wrong is what would make prune useless.
`pruneOldSessions` returns counts, not ids, so a naive design writes the pruned
ids into the backfill cursor. **That is both unnecessary and wrong**, for three
reasons verified against `session-search.ts:294-344`:

1. **A still-listed pruned id already stays skipped.** Backfill loads a session
   only when `cursor[id] !== s.updatedAt` (`:306-311`). A pruned-but-still-in-
   history session still has its cursor entry, so it is skipped — not reloaded.
2. **Reconcile never removes an entry for a listed id.** Cursor entries are
   deleted only when `!listed.has(id)` (`:330-342`). A pruned id that is still
   in `history.list()` keeps its entry; a pruned id that is gone from history
   has its rows *and* cursor removed together, which is also correct.
3. **Writing a sentinel breaks the equality check.** A reserved value would
   make `cursor[id] !== s.updatedAt` true, so backfill would *deliberately*
   re-index the very session we just pruned. The "obvious" fix is the bug.

Therefore retention does exactly one thing:

```
runScopedSessionRetention(db, days, ready, isDisposed):
  await ready
  if isDisposed() return
  dbManager.withCorruptionRecovery(() => pruneOldSessions(dbManager, days))
```

No cursor export, no id SELECT, no `history` argument. The single forced
reimplementation is calling the pure upstream `pruneOldSessions` directly
instead of upstream's `index.ts:251` startup hook (which assumes a file-root
entry and is not reachable from a host-loaded provider). Recorded in §4 R2;
pinned by a test that runs prune then a backfill pass and asserts the pruned
session stays absent.

### 2.4 Final mount shape

As in §2.2: retention kickoff immediately before the existing backfill kickoff,
both gated by `sessionSearchEnabled && options.history`, retention additionally
by `config.sessionRetentionDays > 0`. No host field, no new option — retention
reads `sessionRetentionDays` already present in `options.config` (§1 fact 6).

## 3. Impact surface — every file and every caller

| File | Change | Ownership |
| --- | --- | --- |
| `src/scoped/entry.ts` | `ready` chain awaits `store.maintainRecoveryFiles()`; add retention kickoff before backfill | fork-owned |
| `src/scoped/session-retention.ts` | **new**: `withCorruptionRecovery(() => pruneOldSessions(...))` | fork-owned |
| `src/scoped/session-search.ts` | no change — cursor logic stays private | fork-owned |
| `tests/scoped/session-maintenance.test.ts` | **new**: D + A regression tests | fork-owned |
| `docs/fork/TASKS.md` | #4 partial status | fork-owned |
| `docs/fork/P6-SESSION-MAINTENANCE-DESIGN.md` | this record | fork-owned |

**Upstream files checked for accidental edits:** `src/store/session-indexer.ts`
(`pruneOldSessions`, `indexSessionOnce` — imported/called only), `src/store/memory-store.ts`
(`maintainRecoveryFiles` — called only), `src/store/recovery-maintenance.ts`
(not imported — its path traversal is the forced part we avoid), `src/store/db.ts`,
`src/config.ts`, `src/types.ts`, `src/index.ts` — **none modified**. No new
`divergences.json` row.

**Callers of changed signatures — enumerated:**

| Symbol | Existing call sites | Treatment |
| --- | --- | --- |
| `MemoryStore.maintainRecoveryFiles()` | `layered-store.ts:59`; `recovery-maintenance.ts:59` (upstream) | New caller in `entry.ts` ready chain; signature unchanged. |
| `pruneOldSessions(db, days)` | `src/index.ts:251` (upstream startup) | New fork caller in `session-retention.ts`; signature unchanged. |
| `openScopedHermesMemory(options)` | `provider.ts:106`; scoped tests | Signature unchanged — retention reads `config.sessionRetentionDays` already in `options.config`. |
| `provider.open()` | agent-chat `session.ts:815-830` | Unchanged. No host field added in this slice. |

## 4. Risks

| ID | Risk | Decision / mitigation |
| --- | --- | --- |
| R1 | **Default-value change:** wiring prune changes behavior whenever `config.sessionRetentionDays > 0`; upstream default is `0` and scoped inherits it. | **Keep aligned, default 0 = disabled.** No host currently sets it, so no production behavior change. Guard in `entry.ts` skips even starting the async task. Test asserts a tenant with no retention keeps all sessions. |
| R2 | **Forced reimplementation:** upstream's prune runs from `index.ts:251` at CLI startup; a host-loaded provider never executes that entry, so the call must be restated in a fork-owned module. | Call the pure upstream `pruneOldSessions` directly (no SQL copy, no id list). Recorded here per `UPSTREAM-MAPPING.md` §3.1. A test runs prune → backfill and asserts the pruned session stays absent, so a future change to backfill's skip rule is caught. |
| R3 | **Ordering between retention and backfill:** if backfill loads a row before prune deletes it, the same open can re-add a pruned session. | Both await the same `ready`; retention is kicked off first and its prune is synchronous (`withCorruptionRecovery` body), completing before backfill's first `await history.list()`. Test drives both in sequence. |
| R4 | **`ready` rejection:** a throwing `maintainRecoveryFiles` or prune would reject `ready`, which `promptSection()` awaits. | Both run inside the existing `ready` chain whose `.catch` logs and resolves (the catch is already in place at `entry.ts:356-362`). Sidecar maintenance is best-effort; a corrupt sidecar must not block a prompt. Test asserts `ready` resolves with a throwing sidecar. |
| R5 | **Prune removes a live session's rows.** `pruneOldSessions` uses `started_at`; a long-running current session started > window ago could be eligible. | Upstream has the same property; retention is opt-in and the current session is re-indexed on the next `turn_end` (`attachScopedSessionIndex`). Accept, aligned with upstream; note in TASKS. |
| R6 | **Windows open handles / teardown.** Recovery sidecar maintenance touches files while a late event may hit a closed DB. | Both jobs run once at open, before any tenant writes; DB work is wrapped in `withCorruptionRecovery`, and `isDisposed()` guards retention. Follows the established teardown discipline (`dispose`/`erase` set `dbClosed`, `entry.ts:309-312`). |

## 5. Cross-references checked (after writing)

| Claim | Source | Checked |
| --- | --- | --- |
| facade delegates `maintainRecoveryFiles` to both roots | `src/scoped/layered-store.ts:58-59` | yes |
| `MemoryStore.maintainRecoveryFiles` is sidecar-only | `src/store/memory-store.ts:205-210` | yes |
| no scoped caller of `maintainRecoveryFiles` | repo grep: only layered-store + recovery-maintenance | yes |
| upstream wrapper needs projectsRoot + fresh store | `src/store/recovery-maintenance.ts:35-50,52-66` | yes |
| `pruneOldSessions` is pure DB with started_at fallback | `src/store/session-indexer.ts:680-730` | yes |
| `started_at` written by indexSessionOnce | `src/store/session-indexer.ts:104-108` | yes |
| scoped header guard requires timestamp | `src/scoped/session-search.ts:279-286` | yes |
| `sessionRetentionDays` is a MemoryConfig field, default validated | `src/types.ts:142`, `src/config.ts:119,232-233` | yes |
| scoped config spreads defaultMemoryConfig + options.config | `src/scoped/entry.ts:234-236` | yes |
| backfill skips ids whose cursor equals updatedAt | `src/scoped/session-search.ts:306-311` | yes |
| reconcile deletes cursor ids absent from list | `src/scoped/session-search.ts:327-342` | yes |
| ready chain catch logs via queueMicrotask | `src/scoped/entry.ts:346-362` | yes |
| backfill kickoff guarded by sessionSearchEnabled && history | `src/scoped/entry.ts:369-380` | yes |
| layered facade assigned at entry.ts | `src/scoped/entry.ts:260-263` | yes |
| promptSection awaits ready | `src/scoped/entry.ts:403-404` | yes |

## 6. Ship order

1. This design record (already written).
2. D: add the `await store.maintainRecoveryFiles()` line + test (fails-then-passes).
3. A: export cursor accessors, add `session-retention.ts`, add kickoff + tests.
4. `npm run check`, targeted tests, full suite (`TEST_TIMEOUT=400 npm test`),
   `npm run upstream:check:ci`.
5. Fork PR (base/head `njuptlzf/pi-hermes-memory`), docs/status update in `TASKS.md`.
6. agent-chat contract work (if retention is to be host-configurable) is a
   **separate repo/PR**, out of scope here — see `WIRING-CONTRACT.md` §5.

## 7. Host reachability — `ctx.policy.dataRetentionDays` (follow-up to §6 step 6)

§6 shipped the prune behind `config.sessionRetentionDays`, defaulting to 0 and
documenting that host configurability was a separate agent-chat effort. That
contract landed (agent-chat docs: `记忆数据保留政策设计稿.md`, spec baseline
PRs #18–#21). This section wires the fork end.

### 7.1 Call chain — exact code shapes

```
agent-chat session.ts   resolveMemoryProvider(...).open({ ..., policy })
  └─ provider.ts        ProviderContext.policy?: { dataRetentionDays?: number }
       └─ openScopedHermesMemory({ ..., policy: ctx.policy })
            └─ entry.ts openWithRoots
                 const retentionDays = options.policy?.dataRetentionDays
                                       ?? tuning?.retentionDays;      // policy first
                 config = { ...default, ...options.config,
                   ...(retentionDays !== undefined
                     ? { sessionRetentionDays: retentionDays } : {}),  // Chain A
                   ... }
                 // gate unchanged (§2.2): (config.sessionRetentionDays ?? 0) > 0
                 //   → runScopedSessionRetention(dbManager, days, ready, dbClosed)
```

- **Chain A fold**, same shape as `reviewEveryTurns → nudgeInterval`
  (`entry.ts:241`). `sessionRetentionDays` is a real `MemoryConfig` field
  (`types.ts:142`), so nothing is re-derived and no new number is invented.
- **Precedence policy > tuning > raw `options.config` spread order**: policy
  and tuning collapse into one variable folded after the config spread, so
  either beats a legacy `config.sessionRetentionDays`; between them `??`
  keeps the host's governance ahead of the caller's knob.
- **`capabilities.dataRetention: true`** (`provider.ts:88-100`) declares the
  promise the host can warn against: sessions older than N days are no longer
  retrievable from the tenant mirror. It is a fact about §2.2's prune, not a
  switch — a host passing `policy` to a provider without this flag gets
  agent-chat's mismatch warning, not a silent no-op.

### 7.2 Impact surface

| File | Change |
| --- | --- |
| `src/scoped/provider.ts` | `ProviderContext.policy?`; `capabilities.dataRetention`; forward `policy` at the `openScopedHermesMemory` call site |
| `src/scoped/entry.ts` | `ScopedHermesOptions.policy?`; `ScopedMemoryTuning.retentionDays?`; `retentionDays` local + Chain A fold line |
| `tests/scoped/session-maintenance.test.ts` | cases 7 (policy-only prune, no `config`) and 8 (policy> tuning, tuning-alone fallback) |
| `tests/scoped/provider.test.ts` | descriptor assertion for `dataRetention: true` |

No upstream file touched; zero new `divergences.json` rows; the §2.2 gate and
`session-retention.ts` are unchanged — this PR only feeds the existing door.

### 7.3 Risks

- **Default behavior unchanged**: no `policy`, no `tuning` → `retentionDays`
  stays undefined → gate reads `0` → no task, identical to §6. The whole host
  path is opt-in via a product manifest field.
- **Misread semantics** (prune ≠ history deletion): guarded by the capability
  doc-comment and agent-chat's policy draft §2.1 wording ("no longer
  retrievable", HistoryStore stays authoritative).
- **Precedence trap**: a direct user passing both `config.sessionRetentionDays`
  AND `policy`/`tuning` gets the folded value (policy/tuning wins) — matches
  the injected-root-wins rule at `entry.ts:251-253`; documented in 7.1.

### 7.4 Cross-references (checked after writing)

| Claim | Where | Verified |
| --- | --- | --- |
| Chain A fold line exists for 5 prior fields | `entry.ts:241-250` | yes |
| §2.2 gate reads `config.sessionRetentionDays` | `entry.ts` kickoff `?? 0 > 0` | yes |
| `sessionRetentionDays` upstream default 0 | `types.ts:142`, `constants.ts` | yes |
| capability doc pattern = sharedProfile precedent | `provider.ts:80-90` | yes |
| host side contract (out of fork repo) | agent-chat `docs/design/记忆数据保留政策设计稿.md` | pointer only, per WIRING-CONTRACT §5 |
