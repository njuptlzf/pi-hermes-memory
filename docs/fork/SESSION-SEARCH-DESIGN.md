# Session search design — scoped `session_search` (#3, current-session slice)

> **Status: proposed, not implemented.** This is a design record under
> `UPSTREAM-MAPPING.md` §3.2 — an implementation contract, not a sketch. It
> covers backlog row **#3** (`session_search`) and the **minimum** indexing
> needed to make that tool answer anything: live indexing of the *current*
> session's messages.
>
> It deliberately does **not** cover the rest of #4 (backfill, prune,
> `session_files`, shutdown index from a JSONL file) or the host port for
> *past* sessions. Those are named as non-goals in §2 and deferred to a
> follow-up record. The reason for the split is §3: the current session is
> already available through `ctx.sessionManager`; past sessions are not.

## 0. What this buys, and what it does not

`MEMORY.md` is a compressed conclusion. Review and flush summarise the
conversation and discard the wording. The missing capability is **verbatim
recall**: "what exactly did we say about the migration last week", including
the original message text, role and time. `memory_search` cannot answer that —
it searches `memories`/`memory_fts`, a different row space in the same SQLite
file (§1 item 2; `schema.ts:74-95`, `db.ts:183`).

After this slice, a tenant can search the **current** session's messages
verbatim. After a `session_shutdown` + new session, those rows remain in that
tenant's `sessions.db` (the file is per-tenant, not per-session), so the tool
can still find them until retention/erasure removes them. What it cannot yet do
is pull in sessions the host restored from its own `HistoryStore` before this
provider was installed, or sessions from a different scope — see §2.

## 1. Problem

Three independent facts about the current tree:

1. **`session_search` is not mounted.** `src/scoped/entry.ts:348` hardcodes
   `hasSessionSearch: false`, and `mount()` (`entry.ts:379-463`) registers only
   `registerMemoryTool` (:422), `registerMemorySearchTool` (:423) and retrieval
   (:429-435). The policy prompt correctly omits the tool sentence
   (`policy.ts:47-50`) because claiming an absent tool would waste a model turn.
2. **The tables exist but are empty.** `src/store/schema.ts:21-71` defines
   `sessions`, `messages` and `message_fts` in the same `SCHEMA_SQL` that
   `DatabaseManager` applies unconditionally (`db.ts:391-414`). The scoped
   tenant opens that manager at `entry.ts:267` (`new DatabaseManager(layout.memoryDir)`),
   so every tenant DB already has the session tables — nothing writes to them
   because `seedSearchMirror()` (`entry.ts:277-292`) only reconciles
   `memories`/`memory_fts`.
3. **The upstream mount path cannot be imported as-is.**
   `src/tools/session-search-tool.ts:10` imports `AGENT_ROOT`, and :30 evaluates
   `DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions')` at **import time**.
   Importing `registerSessionSearchTool` into a scoped module executes that
   `process.env`/`os.homedir()` read (`src/paths.ts:5-10`), violating the
   boundary rule in `AGENTS.md` and the host's admission scan. The two planned
   divergences in `divergences.json:91-115` cover exactly these constants but
   are not implemented.

So the work is: mount a tool whose registration is fork-owned (no import-time
env/home), feed the existing tables from a source the scoped adapter actually
has, and flip the policy flag only when the tool is really mounted.

## 2. Goals and non-goals

**Goals**

1. Mount a `session_search` tool in the scoped entry that searches this
   tenant's `messages`/`message_fts` with upstream's query logic.
2. Index the **current** session's messages into those tables as turns end.
3. Keep the tool and its rows strictly per-tenant; no host-global session path.
4. Make `hasSessionSearch` true only when the tool is actually mounted, with an
   opt-out switch for direct `openScopedHermesMemory` users and tests (§4.1 —
   the host cannot currently reach it; that is explicit, not accidental).
5. Touch **zero upstream files**; add nothing to `divergences.json`.

**Non-goals**

- **Anchors variant.** `config.sessionSearch.variant = "anchors"` scans JSONL
  files (`src/store/session-anchor-search.ts:72-122`). agent-chat builds its Pi
  session with `SessionManager.inMemory(cwd, undefined, opts.history)`
  (`agent-chat session.ts:829`); `inMemory` never sets `sessionFile`
  (`session-manager.js:643-659,1375-1377`), so there is no JSONL to scan. The
  scoped mount must force legacy (see §8 R3).
- **Backfill / `session_files` / prune / retention.** `needsBackfill`,
  `indexChangedSessions`, `pruneOldSessions` and the `session_files` increment
  state (`src/store/session-indexer.ts:539-605,451-509,680-730,338-355`) all
  need a directory of session files. No such root exists for a tenant.
- **A host history port.** Reading `HistoryStore` (agent-chat `stores.ts:13-35`,
  keyed by `userId/scope/sessionId`) would require a protocol field; that is
  the follow-up that unlocks true cross-session recall. This record does not
  add it.
- **`registerCommand` / `/memory-index-sessions`.** Inert under rpc; the host
  owns any manual trigger.
- **Project dimension.** No project store in a tenant (`entry.ts:414-416`).

## 3. Data source: what is actually available, and which function to call

The host owns persistence, but it hands the *current* session back to Pi on
every request: `opts.history?: FileEntry[]` from `HistoryStore`
(`agent-chat session.ts:222-223`) is passed to `SessionManager.inMemory` at
:829. Pi reconstructs a header from those entries
(`session-manager.js:718-720`, `_loadEntries` finds the `type: "session"`
entry), so inside a tool/event handler:

- `ctx.sessionManager.getHeader()` returns `{ id, timestamp, cwd }`;
- `ctx.sessionManager.getEntries()` returns the current session's entries;
- `ctx.sessionManager.getSessionFile()` returns `undefined` (no file).

`parseSessionManagerSnapshot()` (`src/store/session-indexer.ts:233-249`)
accepts exactly a structural `SessionManagerSnapshot` of
`getHeader()/getEntries()/getSessionFile?` (:159-163) and needs only the first
two. It is pure, imports no Pi SDK and no `AGENT_ROOT` (its module imports are
`fs`, `constants.ts`, `db.js`, `session-parser.ts` at :1-4 — none reads env at
import time). The upstream test helper at
`tests/store/session-indexer.test.ts:457-462` confirms a snapshot without
`getSessionFile` is valid.

### 3.1 The `indexLiveSession` trap

**Do not call `indexLiveSession()`.** Its inner function
`indexLiveSessionOnce()` (`session-indexer.ts:261-274`) does:

```ts
const sessionFile = sessionManager.getSessionFile?.();
if (sessionManager.getSessionFile && !sessionFile) return null;   // :262-263
```

agent-chat's `SessionManager` **has** the method (it appears on the class),
but it returns `undefined`. The guard therefore returns `null` on every call
and nothing is indexed. This is not a bug to fix in this slice — it is why the
scoped mount uses:

```ts
indexCurrentSession(dbManager, ctx.sessionManager)
```

(`session-indexer.ts:251-255`), which calls `parseSessionManagerSnapshot()`
directly and has no file dependency. It is idempotent: `indexSessionOnce()`
uses `INSERT OR IGNORE` for sessions (:103-106) and messages (:108-111), and
already-indexed messages produce `skipped: true` with `messagesIndexed: 0`
(proven by `tests/store/session-indexer.test.ts:679-712`). Calling it on every
`turn_end` adds only newly appended messages.

If corruption recovery is wanted, wrap the call in
`dbManager.withCorruptionRecovery(() => ...)` (public at `db.ts:249`), since
`indexCurrentSession` — unlike `indexLiveSession` (:257-259) — has no wrapper.

## 4. Option surface and full call chain

Everything new is additive and forks only fork-owned types. No field is added
to upstream `MemoryConfig` or to the host protocol in this slice.

### 4.1 Fork-owned option

In `src/scoped/entry.ts`, extend `ScopedMemoryTuning` (currently :79-104):

```ts
/** Mount `session_search` and index the current session. Default true. */
readonly sessionSearch?: boolean;
```

and `ScopedHermesOptions` inherits it through `tuning` (:114). Like `nudgeMode`,
the field cannot be folded into `config` because upstream `SessionSearchConfig`
(`src/types.ts:15-18`) has no enable bit — only `variant`.

**Host reachability — be precise about what exists today.** The fork's own
`ProviderContext` declares `tuning?: ScopedMemoryTuning`
(`src/scoped/provider.ts:59`) and forwards it at :112. The **agent-chat host**
does **not**: `MemoryProviderContext` in
`agent-chat/packages/protocol/src/memory-provider.ts:63-81` has only
`storageRoot`, `sharedRoot`, `agentDir`, `scope`, `complete`, and the call site
`agent-chat/packages/server/src/session.ts:760-768` passes exactly those five.
There is no `tuning` and no `sessionSearch` field anywhere in agent-chat.
Consequently, on the production host path `ctx.tuning` is `undefined` and the
tool is **always mounted**. The switch is a fork-owned opt-out for direct
`openScopedHermesMemory` users and tests, mirroring how P4's additive knobs are
typed. Making it host-reachable would require a separate agent-chat protocol
change (the same shape as the history port in §9) and is **not** part of this
slice. Calling it a "host-injected switch" would be false.

### 4.2 Call chain — exact code shapes

Two views of the same wiring — the value flow, then the exact mount lines.
Note the labels here are **local**, not P4 §4.2.1's Chain A/B: P4's labels
classify fields by whether they exist in `MemoryConfig`, whereas here both
views describe the same additive field. `sessionSearch` has no `MemoryConfig`
counterpart (`src/types.ts:15-18`), so under P4's taxonomy it is a Chain-B-type
field passed explicitly at the mount.

**Value flow — the tool and its index are mounted unconditionally on the host
path.** The only gate is the fork-owned opt-out, which defaults to on:

```
direct user: openScopedHermesMemory({ ..., tuning: { sessionSearch: false } })
  → entry.openWithRoots(): const sessionSearchEnabled =
        options.tuning?.sessionSearch !== false;             // default true
  → entry.mount(pi):  if (sessionSearchEnabled) { ... }       // two calls, see below
  → entry.promptSection(): buildScopedMemoryPolicy({
        ...,
        hasSessionSearch: sessionSearchEnabled,               // was `false` at :348
    })

host path: agent-chat session.ts:760-768 → provider.open(ctx)  (no tuning field)
  → src/scoped/provider.ts:112 passes `tuning: ctx.tuning` === undefined
  → sessionSearchEnabled === true; tool and index always mounted
```

**Mount-site code shape.** Both calls must be added
inside `mount()` at `src/scoped/entry.ts:379-463`, next to the existing
`registerMemoryTool`/`registerMemorySearchTool` at :422-423:

```ts
if (sessionSearchEnabled) {
  mountScopedSessionSearch(observedPi, dbManager);            // new line after :423
  attachScopedSessionIndex(pi, dbManager, ready);              // new line after :423
}
```

`observedPi` (created at :421) is used for registration so the tool passes
through the same metrics Proxy as the other tools; the index listeners attach
to the raw `pi` because they are handlers, not tool registrations. `ready` is
the promise defined at :305-315, so indexing waits for the mirror seed and an
open DB. Forgetting either line is invisible to the type checker; §7 test 8
asserts the mount behavior end to end.

The tool registration itself is a new fork-owned module,
`src/scoped/session-search.ts`:

```ts
import { searchSessions, getIndexedMessageCount } from "../store/session-search.js";
import { createSharedToolResultRenderer } from "../tools/shared-output-view.js";
import { searchResultView } from "../tools/tool-result-views.js";
import type { DatabaseManager } from "../store/db.js";

export function mountScopedSessionSearch(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: "session_search",
    // schema + execute copied from registerLegacySessionSearchTool
    // (src/tools/session-search-tool.ts:146-246), with `project` inert
  });
}
export function attachScopedSessionIndex(
  pi: ExtensionAPI, dbManager: DatabaseManager, isReady: Promise<void>,
): void { /* §4.3 */ }
```

Why a new module instead of importing `registerSessionSearchTool`: importing it
pulls `AGENT_ROOT` (§1). The pure functions it calls —
`searchSessions()` (`src/store/session-search.ts:72-211`) and
`getIndexedMessageCount()` (:216-220) — are safe and are reused, not
re-derived. The shared renderer/view helpers (`tools/shared-output-view.ts`,
`tools/tool-result-views.ts`) are also pure. Only the ~100-line tool wrapper is
restated, and §8 R1 records the drift risk explicitly.

**Failure mode to guard against:** adding `tuning.sessionSearch` but forgetting
the `entry.ts` mount/policy lines. Type checking cannot catch an optional
field; `hasSessionSearch` would stay false and the host's setting would be
silently ignored. §7 test 8 asserts the behavior through the entry mount.

### 4.3 Index trigger — no new host events needed

scoped already subscribes to the events it needs (`src/scoped/entry.ts:385`,
`review-flush.ts:129,133,180`, `correction.ts:75,85`). Add two more listeners
inside `attachScopedSessionIndex`:

```ts
pi.on("turn_end", async (_event, ctx) => {
  await isReady;                       // dbManager is open; seed mirrors first
  try {
    dbManager.withCorruptionRecovery(() =>
      indexCurrentSession(dbManager, ctx.sessionManager));
  } catch { /* best-effort: indexing must never break a turn */ }
});

pi.on("session_shutdown", async (_event, ctx) => {
  await isReady;
  try {
    dbManager.withCorruptionRecovery(() =>
      indexCurrentSession(dbManager, ctx.sessionManager));
  } catch { /* best-effort: teardown must not fail on a stale index */ }
});
```

`ctx.sessionManager` is typed on `ExtensionContext` in both installed Pi
versions: `getHeader(): SessionHeader | null` (agent-chat
`session-manager.d.ts:333`) and `getEntries(): SessionEntry[]` (:341). It is
read-only to the extension. `turn_end` fires **after** the assistant message
and all tool results are appended (agent-chat `agent-session.js:849-852`), so
the snapshot is complete for that turn. `session_shutdown` supplies the final
flush before `dispose()` closes the DB (`entry.ts:484-493`).

No host-side lifecycle port is required: `factory(pi)` receives the same Pi
object that emits these events (`agent-chat session.ts:806,841`). This is the
correction to an earlier assumption that the host would need to provide new
"session available / message ended / session ended" notifications.

## 5. Cross-references checked

| Claim | Source | Checked |
| --- | --- | --- |
| `session_search` not mounted; flag false | `src/scoped/entry.ts:348`, `mount()` :379-463 | yes |
| Policy sentence gated by flag | `src/scoped/policy.ts:22-23`, :47-50 | yes |
| Tenant DB path / schema | `entry.ts:267`; `src/store/schema.ts:21-71`; `db.ts:391-414` | yes |
| Mirror writes only memories | `entry.ts:277-292`; `sqlite-memory-store.ts:502-628` | yes |
| Tool wrapper imports AGENT_ROOT at import | `src/tools/session-search-tool.ts:10,30`; `src/paths.ts:5-10` | yes |
| Legacy tool schema/execute | `src/tools/session-search-tool.ts:146-246` | yes |
| Pure search functions | `src/store/session-search.ts:72-211,216-220` | yes |
| `indexCurrentSession` is pure and idempotent | `src/store/session-indexer.ts:251-255,97-157`; test :679-712 | yes |
| `indexLiveSession` returns null without a file | `session-indexer.ts:257-274` | yes |
| Snapshot needs only header+entries | `session-indexer.ts:159-163,233-249`; test :457-462 | yes |
| Provider tuning passthrough already exists | `src/scoped/provider.ts:59,106-113` | yes |
| Planned import-time constant divergences | `docs/fork/divergences.json:91-115` | yes |
| Host uses inMemory session, no JSONL | agent-chat `session.ts:829`; `session-manager.js:643-659,1375-1377` | yes |
| Host emits events through shared pi | agent-chat `session.ts:806,841`; `agent-session.js:543-568,849-852` | yes |

## 6. Impact surface — every file on the chain

| File | Change | Ownership |
| --- | --- | --- |
| `src/scoped/session-search.ts` | **new**: tool registration + index listeners | fork-owned |
| `src/scoped/entry.ts` | `tuning.sessionSearch` read; mount tool + index; `hasSessionSearch` computed at :348 | fork-owned |
| `src/scoped/policy.ts` | no change — `hasSessionSearch` text already exists at :47-50 | fork-owned |
| `src/scoped/provider.ts` | no change — `tuning` already forwarded at :112 | fork-owned |
| `tests/scoped/session-search.test.ts` | **new**: tool + isolation tests (§7) | fork-owned |
| `docs/fork/TASKS.md` | #3 status | fork-owned |
| `docs/fork/SESSION-SEARCH-DESIGN.md` | this record | fork-owned |

**Upstream files checked for accidental edits:** `src/tools/session-search-tool.ts`
(imported helpers only — no edit), `src/store/session-search.ts`,
`src/store/session-indexer.ts`, `src/store/schema.ts`, `src/store/db.ts`,
`src/store/session-parser.ts`, `src/tools/shared-output-view.ts`,
`src/tools/tool-result-views.ts`, `src/types.ts`, `src/config.ts`,
`src/paths.ts` — none is modified. **`divergences.json` gains no entry.**
The two `planned` rows at :91-115 stay planned; this slice routes around them
by not importing the affected modules.

**Callers of changed signatures — enumerated, not asserted.**


| Symbol | Existing call sites | Treatment |
| --- | --- | --- |
| `indexCurrentSession(dbManager, snapshot)` | `src/index.ts` (upstream, via `indexLiveSessionOnce` at `session-indexer.ts:273`); `tests/store/session-indexer.test.ts:690,702,708` | Signature unchanged. New fork caller in `src/scoped/session-search.ts` (§4.3). Upstream caller stays on the existing path — no default change for it. |
| `searchSessions(dbManager, query, opts)` | `src/tools/session-search-tool.ts:201`; `tests/store/session-search.test.ts` | Signature unchanged. New fork caller in the scoped tool wrapper. |
| `getIndexedMessageCount(dbManager)` | `src/tools/session-search-tool.ts:195`; `tests/store/session-search.test.ts` | Signature unchanged. New fork caller in the scoped tool wrapper. |
| `buildScopedMemoryPolicy(options)` | `src/scoped/entry.ts:340` (production); scoped prompt tests | Signature unchanged; only `hasSessionSearch` changes from the literal `false` at :348. |
| `mountScopedSessionSearch` / `attachScopedSessionIndex` | none (new) | Called only from `entry.ts:mount()` — see "Mount-site code shape" in §4.2 for the exact lines. |
| `openScopedHermesMemory(options)` | `src/scoped/provider.ts:106`; scoped tests | Signature unchanged; `tuning` already exists. |
| `provider.open()` | agent-chat `session.ts:760-768` | Unchanged. Confirmed no `tuning` is passed — see §4.1. |

## 7. Tests

`tests/scoped/session-search.test.ts`, using a minimal fake `pi` with
`on`/`registerTool` (the pattern from `tests/scoped/tuning.test.ts`), real
`DatabaseManager` on a temp dir, and a snapshot with `getHeader`/`getEntries`
but **no** `getSessionFile` (to pin the §3.1 trap):

1. **Tool is registered** only when `tuning.sessionSearch !== false`;
   `hasSessionSearch` in `promptSection()` matches the mount state.
2. **Index then search** — fire `turn_end` with one user + one assistant entry,
   then call the tool's `execute` with a term from the assistant text: a hit is
   returned with role, date and snippet.
3. **Idempotence** — fire the same `turn_end` twice; `messages` count stays 1
   per entry and no duplicate hits appear.
4. **Incremental** — add a second entry, fire `turn_end` again; only the new
   message is added (`messagesIndexed` goes 1 → 0 on a no-op re-run, as in the
   upstream test at :679-712).
5. **Shutdown flush** — an entry appended after the last `turn_end` is indexed
   by `session_shutdown`.
6. **Tenant isolation** — two tenants with the same query; each tool sees only
   its own DB rows (mirrors `tests/scoped/multi-tenant.test.ts`).
7. **Best-effort** — a throwing `complete`-less path or a closed DB does not
   propagate out of the event handler.
8. **Chain is wired through the entry** — mount a handle with
   `tuning: { sessionSearch: false }` and confirm no tool is registered and
   `promptSection()` omits the sentence; mount with `true` (or omitted) and
   confirm the opposite. A design/impl that only adds the type field will fail
   here and pass 1-7.
9. **No env/home read at import** — import the new module in a child process
   with `PI_CODING_AGENT_DIR` pointing at a sentinel path and assert no file
   under it is touched (guards against accidentally importing
   `session-search-tool.ts` later).

## 8. Risks

| ID | Risk | Mitigation / decision |
| --- | --- | --- |
| R0 | **Default-value change:** `hasSessionSearch` moves from the literal `false` (`entry.ts:348`) to "mounted by default" whenever `tuning.sessionSearch` is omitted — which is **every** production call, because agent-chat does not pass `tuning` (§4.1). Consequence: every agent-chat tenant gains a new tool in its schema and a `session_search` sentence in its prompt, plus one small indexed transaction per turn (R6), without any host-side opt-in. | **Decision: keep as additive, default on** — the feature is the goal of #3, and an opt-in default would leave it permanently off on the only host that uses this provider. Recorded here explicitly per `UPSTREAM-MAPPING.md` §3.2 element 4. The cost is borne per tenant and bounded by the tenant DB. A direct user who wants the old surface sets `tuning.sessionSearch: false`; making that reachable from agent-chat requires a protocol change and is a follow-up (§9). Test 8 pins both states. |
| R1 | **Tool wrapper is restated.** ~100 lines of schema/snippet/cap logic are copied from `src/tools/session-search-tool.ts:146-246` because that module imports `AGENT_ROOT` at load time. This is a **forced** reimplementation (`UPSTREAM-MAPPING.md` §3.1), not a convenience rewrite; the constraint is named in the new file's header. Drift risk: upstream edits to limits/description will not flow automatically. | Reuse the pure functions and constants where exported; keep the wrapper thin; note in TASKS.md that a future lazy-constant divergence (already planned at `divergences.json:104-115`) would let us delete the wrapper and import upstream's directly. |
| R2 | **`indexLiveSession` trap** — using it silently indexes nothing because agent-chat's `getSessionFile` exists but returns undefined (`session-indexer.ts:262-263`). | §3.1 mandates `indexCurrentSession` + `withCorruptionRecovery`. Test 2 fails if the wrong function is used (no hits). |
| R3 | **Variant default.** Upstream default is `legacy` (`config.ts:117`), but a host could set `config.sessionSearch.variant = "anchors"` through `ScopedHermesOptions.config` — anchors has no data source here. | Decision: the fork-owned mount **ignores** `variant` and always uses legacy. Additive, documented here; no default-value change for the tool's behavior. A host asking for anchors gets legacy results rather than a tool that returns nothing. |
| R4 | **Project filter.** Upstream's tool exposes `project` (`session-search-tool.ts:166`) and `searchSessions` filters `s.project` (`session-search.ts:105-109`). `parseSessionManagerSnapshot` derives project from `header.cwd.split('/').pop()` (:243) — a cwd basename, not a project store. | Decision: keep the parameter but treat it as the cwd-derived label, not a project axis; no project store is introduced. Windows path separators (`\`) mean the basename can be the whole path — cosmetic in the result header, not an isolation issue. Do not "fix" by reintroducing a project dimension. |
| R5 | **Session id is host-owned.** `header.id` comes from the restored history; a new scope/session id creates a new row. Old rows stay in the tenant DB until erasure; no prune in this slice. | Accepted: the file is per-tenant, so growth is bounded by that tenant. Retention (#4) is a follow-up; §2 names it. |
| R6 | **Write volume.** `turn_end` writes on every turn; content is truncated by `truncateMessageContent` (`session-indexer.ts:137` → `constants.ts` max) and inserts are `INSERT OR IGNORE`, so steady-state cost is one small transaction per turn. | Tests 3-4 pin idempotence. A direct user can disable the slice with `tuning.sessionSearch: false`; on the agent-chat path the cost is accepted with R0's default-on decision until the protocol carries the flag. |
| R7 | **Import-time env coupling.** Adding an import of `session-search-tool.ts` or `index-sessions.ts` later would reintroduce `AGENT_ROOT` eval. | Test 9 runs in a child process with a sentinel env path. The new module's header names the constraint. |
| R8 | **Windows: temp dirs + open SQLite handles.** | Handlers close/dispose before removing temp dirs (lesson from 2026-11-22); no entry-level integration test with real Pi session. |

## 9. Follow-up (not in this record)

The step after this slice is the host history port: add a read-only field to
`MemoryProviderContext` (agent-chat `packages/protocol/src/memory-provider.ts:63-81`)
that returns `FileEntry[]` for the current `scope`, then feed those entries
through backfill (`indexChangedSessions`) so past sessions become searchable.
That same protocol change is the natural place to carry a `tuning`/`sessionSearch`
flag, which would make the opt-out in §4.1 reachable from agent-chat (R0).
That is the change that makes #3 fully answer "what did we discuss last week"
across sessions; this record only makes "in this session, verbatim" work.
