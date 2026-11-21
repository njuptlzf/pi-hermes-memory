# Scoped fork backlog

Fork-owned file. Upstream does not know this path, so a merge never touches it.
Companion to `docs/fork/UPSTREAM-MAPPING.md` (what the fork is allowed to change)
and `docs/fork/F0-BASELINE.md` (the measured baseline).

Status verified **2026-11-21** on `main` at `0538b7f` (fork line graduated from `spike/f0-scoped-entry`).
Current fork tag: `v0.11.0-scoped.6`. P0–P2 are complete (P2 merged in PR #3, `f4407f7`).
Earlier updates to the host contract and capability flag are recorded inline.

## Done

| Item | Commit | Note |
| --- | --- | --- |
| Tenant-safe scoped entry (per-scope store, no env/globals) | `7c23d00` | |
| Cross-scope user profile + capability-aware policy | `0e18097` | |
| Publishable package + host-neutral provider descriptor | `ee3d8dd` | `@njuptlzf/pi-hermes-memory`, `hermes-scoped` |
| Publish under scoped name + credential guard | `32f3258`, `ce48f29` | `prepublishOnly` rejects credential-shaped files |
| Release smoke fix | `a505420` | tag `v0.11.0-scoped.1` |
| **`memory_search` wiring (per-scope FTS5 mirror)** | `cfa6254` | see below |
| LLM-injection contract + consolidation/review/flush + eval | `51aa48b`, `1cb50de`, `f8f67a2` | all P0 capabilities done |
| `0.11.0-scoped.3` release + repository.url fix | `232e71d` | published via `scripts/publish-scoped.mjs` |
| Manual publish script + CI publish deferred to P3 | `bca9830`, `9fca460` | `scripts/publish-scoped.mjs` |
| Fork line graduated to `main` + `0.11.0-scoped.4` release | — | published under `next` |
| `capabilities.sharedProfile: true` declaration (C6) + `0.11.0-scoped.5` release | `14374c1` | consumed by agent-chat capability contract |
| Host completion contract consumed end to end | agent-chat `v0.8.0` | agent-chat PR #6 merged/published 2026-11-20; `complete` now injected into scoped entry |

Official npm state (verified 2026-11-20): `latest = 0.11.0-scoped.1` (untouched), `next = 0.11.0-scoped.6`.
agent-chat packages are at `v0.8.0` across protocol/server/web (separate repo).
The local `npmmirror.com` mirror lags — do not use it to judge publish state;
pin `--registry=https://registry.npmjs.org --prefer-online` when verifying.

## Retrieval wiring (`cfa6254`) — what it did and did not do

Did: mount the **existing** `memory_search` tool in the scoped entry with one
SQLite FTS5 mirror per scope under `layout.memoryDir`; seed existing Markdown
on open; pass `dbManager` to `registerMemoryTool` so writes stay indexed;
mirror the shared profile into the calling scope; flip `hasSearch: true`.
No retrieval algorithm was written — the engine was already complete.

Did **not**: add vector / hybrid semantic retrieval. The repo has never had
`embedding` / `vector` / cosine code. `ROADMAP.md`'s "Hybrid Memory" means a
compact context + full injection + on-demand search policy, not vector search.
Revisit only if an eval set shows FTS5 recall is insufficient.

## P0 — complete (host side landed 2026-11-20)

| Item | Status | Depends on |
| --- | --- | --- |
| Host LLM-injection contract | **done & published** — agent-chat PR #6, `v0.8.0` (`createMemoryCompletion` in protocol + `session.ts`) | — |
| Auto-consolidation in scoped entry | done (`51aa48b`) | host `complete` callback |
| Background review in scoped entry | done (`1cb50de`) | same `complete` callback |
| Session flush in scoped entry | done (`1cb50de`) | same `complete` callback |
| Memory-quality eval set (24 cases) | done (`f8f67a2`) | — |

All four P0 capabilities are now wired end to end. `runMemoryOps` is the shared runner;
review/flush add no divergence to upstream handlers. Eval baseline 100%.
The host half was originally "pushed but unmerged" (`9ffca33`); it was rebased onto current
main, merged via agent-chat PR #6, and published as `v0.8.0` on 2026-11-20. A regression it
caused in agent-chat's failover suite (background completion stealing scripted model
responses) was fixed in the same PR by disabling memory on that test's product fixture.

The injection contract (`MemoryCompletion`: system+user → text, host owns
timeout/budget) landed in agent-chat's protocol + `session.ts` via
`createMemoryCompletion`, which adapts `modelRuntime.completeSimple` (same
model as the chat session, out-of-band from its history, no failover).
The scoped fork consumes it in `src/scoped/consolidation.ts`: bounded,
atomic-shrink, structured failure, no spawn/env/credentials. Review and flush
reuse the same `runMemoryOps` runner — no upstream handler was modified.

Why this needed a contract change: these three need an LLM call, but their
existing paths both fail inside a host — `pi.exec()` subprocess is forbidden by
`extension-admission.ts`, and `DirectReviewContext` (model/modelRegistry) is
never passed to the scoped entry. The host contract now exposes an optional
`complete` callback; a provider without it simply skips background work.

## P1 — contract

- ~~`capabilities.sharedProfile` not implemented~~ → **DONE 2026-11-20** (`14374c1`,
  `v0.11.0-scoped.5`): provider declares `sharedProfile: true`. The 2026-11-18 decision
  to wait for upstream sync was overtaken; the field was added fork-side without an
  SDK import (structured declaration only).
- ~~No runtime warning when a product depends on cross-scope profile but selects a
  provider that does not support it~~ → **DONE on the host 2026-11-20** (agent-chat C6,
  `v0.6.0`): `agent.memory.requiresSharedProfile` + `sharedProfileMismatchWarning()` in
  `createProductSession` emits an `onUINotify` warning; session still opens. Provider-side
  declaration is the other half of that contract (item above).
- `scoped-memory` C1–C7 hardening not done (external repo, ownership TBD) — **still open**,
  but moot for this fork: `scoped-memory` was **retired** from agent-chat in `v0.7.0`
  (2026-11-20) when `hermes-scoped` became the default. No product can select it anymore.

## P2 — engineering

- [x] Observability: `traceId` + `onMetric` on `provider.open()`, bounded metric
  window with success rate / P95 / cost / tool-failure counts, exposed via
  `session.metrics()`. Instrumentation lives in fork-owned
  `src/scoped/observability.ts`; upstream tool files stay untouched (`441444e`).
  As-implemented design: `docs/fork/P2-OBSERVABILITY-DESIGN.md`
- [x] Hardening: `completionLimits` in `src/scoped/completion-guard.ts` adds a
  defensive 15s timeout, one transient retry, and per-tenant serialisation with
  a 250ms minimum start interval. Host limits still win; the provider no longer
  trusts a host callback to bound itself (`441444e`)
- ~~Eval set~~: **done** (`f8f67a2`) — 24 cases, 90% overall / 100% adversarial
  pass line, runs in CI via `*.test.ts`.

## P3 — low priority: CI auto-publish (deferred 2026-11-19)

**Decision: deprioritized.** Releases are cut by hand with
`node scripts/publish-scoped.mjs` (uses the machine's already-authenticated npm;
never reads or logs the token). CI OIDC publishing is blocked and not worth
the setup cost right now.

To re-enable, in order:
1. Configure a **security key** on the npm account (njuptlzf). npm deprecated
   TOTP (`TotpDeprecated:true`); only a physical/passkey factor is accepted.
   npm requires 2FA at account level before it will let us edit package
   settings ("Please configure 2FA to edit this package").
2. On npmjs.com → `@njuptlzf/pi-hermes-memory` → Settings → Trusted publishing,
   add a GitHub Actions publisher: user `njuptlzf`, repo `pi-hermes-memory`,
   workflow `publish.yml`, environment `publish`, and **check "Allow npm
   publish"** (new configs default to stage-only). The `repository.url` drift
   that caused the earlier E404 is already fixed in `package.json`.
3. Dispatch `publish.yml` with `ref: v<version>`, `dist-tag: next` and verify
   the OIDC publish lands (all earlier "successful" runs had skipped publish
   because the version was already on npm).

## Backlog — upstream surface not wired into scoped (candidates, unassessed)

Recorded 2026-11-21 by comparing the full Pi entry (`src/index.ts`) with the
scoped composition (`src/scoped/entry.ts` and `src/scoped/*`). **This is a
candidate list, not current work, not a priority order, and not a promise to
implement.** For each row, suitability for the in-process/rpc host, tenant
isolation and fork-boundary cost must be analysed when the item is picked up.
Several rows are known to be deliberate exclusions today; that decision is not
being re-made here.

| # | Candidate | Upstream surface | Scoped today / known constraint | Analyse before doing |
| --- | --- | --- | --- | --- |
| 1 | Procedural skills (`skill_manage`) | `SkillStore`, `registerSkillTool`, CRUD, structured `SKILL.md` rendering | not mounted; `hasSkills:false`; `skillsEnabled` has no effect | per-tenant skill roots; whether procedures belong in a scope |
| 2 | Skill discovery / migration | `resources_discover`, legacy skill migration, `ensureDiscoveredRoots` | no discovery handler; no skill roots under the tenant layout | host already owns discovery; avoid duplicates with Pi's own skills |
| 3 | `session_search` tool | legacy SQLite FTS5 variant and `anchors` variant | not mounted; `hasSessionSearch:false` | host owns conversation history; per-scope session source would have to be defined |
| 4 | Session index pipeline | backfill, live index, shutdown indexing, prune/retention, ephemeral cleanup, recovery maintenance, `session_files` metadata | none; tenant SQLite only holds the memory/FTS5 mirror | which root holds session data without leaking across tenants |
| 5 | Correction detection | `setupCorrectionDetector` two-pass pattern filter, immediate save | not wired; corrections only reach memory via periodic review | can reuse `runMemoryOps` + injected `complete`; needs trigger and routing |
| 6 | Tool-call-aware review nudge | tool-call threshold, `reviewEnabled`/`nudgeInterval`/`nudgeToolCalls`, UI notification | scoped review counts only user turns (default 6), no config knobs, no notify | host event shape; whether UI notification belongs to the provider |
| 7 | Project memory layer | cwd binding, `projects-memory/<project>`, `target:"project"` | deliberately absent: tenant root is the scope, `projectStoreRef()` is null | project dimension would reintroduce a shared axis the host removed |
| 8 | Standing instructions store + prompt block | `STANDING.md`, `<standing-instructions>` injected in every mode | no store, no prompt block | user-authored directives in a tenant: who owns and pins them |
| 9 | `/memory-pin` | command to pin/list/remove standing instructions | not registered | `registerCommand` is a no-op in rpc mode; need a tool/port instead |
| 10 | `/memory-insights` | command showing stored memory inventory | not registered | host-side equivalent, if any |
| 11 | `/memory-skills` | command listing procedural skills | not registered | depends on rows 1–2 |
| 12 | `/memory-consolidate` | manual consolidation trigger | not registered; automatic consolidation exists only with `complete` | host-triggered alternative to a TUI command |
| 13 | `/memory-interview` | onboarding interview pre-filling the profile | not registered | onboarding ownership in the host |
| 14 | `/memory-switch-project` | list/switch project memories | not registered | moot while row 7 is absent |
| 15 | `/learn-memory-tool` | command teaching the memory tools | not registered | host can put this in its own docs/prompt |
| 16 | `/memory-sync-markdown` | repair command syncing Markdown into SQLite | not registered; scoped seeds the mirror on every open instead | whether a manual repair path is still needed |
| 17 | `/memory-preview-context` | command previewing the exact injected context | not registered | host-side debug surface, if any |
| 18 | `/memory-index-sessions` | manual session indexing command | not registered | depends on row 4 |
| 19 | Prompt modes | `memoryMode:"legacy-inject"`, policy styles `full/compact/custom/none`, full `<memory-context>` block | scoped always uses `buildScopedMemoryPolicy()` + shared profile + retrieval block | host assembles its own prompt; verify which block is legal |
| 20 | Startup migration / repair | extension-root migration, legacy project-dir migration, skill migration, Markdown→SQLite sync | no migration commands; only per-open mirror reconciliation | tenant roots are host-computed; upstream legacy paths may not exist |
| 21 | Provider option passthrough | `injectPrompt`, `autoRetrieve`, `retrievalBudget`, `profilePromptChars`, review turn/message budgets | supported by `openScopedHermesMemory()` but absent from `ProviderContext`/`provider.open()` | host-neutral way to expose tuning without leaking upstream config |
| 22 | Review/flush config surface | `reviewEnabled`, `nudgeInterval`, `reviewRecentMessages`, UI notifications | scoped review/flush use fixed defaults behind `complete` | same as row 6, plus whether hosts need to tune it |

Not in this backlog because already wired through the shared engine or scoped
adapter: persistent memory/failure writes, `memory_search` with a per-scope
FTS5 mirror, per-turn automatic retrieval, auto-consolidation / background
review / session flush when `complete` is injected, secret scanning, memory
aging, extended store, metrics, `erase()` and `dispose()`.

Housekeeping found during the comparison: the header comment in
`src/scoped/entry.ts` still says background review and session flush are
excluded; the code now wires both through `src/scoped/review-flush.ts`.

## Test reliability (Windows)

Fixed: `background-review.test.ts`'s `reviewInProgress` subtest used a fixed
`settle(5)` plus a never-resolving exec; the real `execChildPrompt`'s temp-file
I/O outlasted the wait on Windows, so the assertion failed and leaked a pending
review into the next test. Reworked to a deterministic started/gate signal.
Also fixed three other Windows-only failures that broke `npm test` on this
machine: `pi-child-process.test.ts` assumed `pi` as the child command
(Windows resolves `node.exe` + CLI path) and asserted POSIX `0o600` mode bits;
`skills-command.test.ts` compared a raw POSIX path against a `path.resolve`d
one; and `package.json`'s test script invoked `tests/run-all.sh` directly
(cmd.exe cannot run a bash script) — now `bash tests/run-all.sh`.
`project-rebinding.test.ts` hung in cleanup because it registered the extension
(opening `sessions.db` + WAL and lock SQLite handles under the temp agent root)
but never fired `session_shutdown`, so Windows could not unlink the open files
and `rmTestDir` retried until the runner timed out. The test now emits the full
shutdown handler chain before teardown; 3/3 fast passes.
`session-indexer.test.ts` also failed on Windows because the `excludeDirs` case
created a literal `nope-*` directory (`*` is illegal in Windows paths). It now
creates `nope-artifacts` and still matches the same `nope-*` glob, so the test
keeps its meaning on both platforms.
`sqlite-lazy-load.test.ts` failed for the same class of reason: its spawned ESM
probe imported bare `D:\...` paths, which Node rejects with
`ERR_UNSUPPORTED_ESM_URL_SCHEME`. It now uses `pathToFileURL().href`.
`sqlite-native.test.ts` compared a `path.join`-derived package root against a
hard-coded POSIX path; the expectation now uses `path.join` too, so separators
no longer matter.

Still slow on this Windows box (pre-existing on clean HEAD, unrelated to fork
code): `extension-root-migration.test.ts` and a few store tests exceed the
default 120s per-file timeout. Use `TEST_TIMEOUT=400 npm test`, or run on Linux
CI. `prompt-injection.test.ts` had the same open-handle issue (registerWith()
re-registers the extension 5× without shutdown); it now collects every shutdown
handler and fires them before `rmTestDir`, so no temp dirs leak.
`tests/run-all.sh` went through `npx` for every file (~50 npm startups); under
long-suite pressure npm intermittently died with "Could not determine Node.js
install directory" and nested spawns stalled. It now prefers the checkout's
local `node_modules/.bin/tsx` and falls back to `npx tsx` only without a local
install. These make the default-timeout full suite deterministic.

## Release mechanics (fork line)

- `release.yml` **always checks out `main`**, whose `package.json` is
  `0.11.0` (upstream, no scoped code). Running it would publish the wrong
  package. Do not use it for the fork line.
- **Manual path (current)**: bump version + `PROVIDER_VERSION` together, add the
  CHANGELOG section, commit/tag, then run `node scripts/publish-scoped.mjs`.
  It uses the machine's `~/.npmrc` token for the official registry (reads only
  its presence, never the value), guards version drift / dirty tree / duplicate
  version / credentials, and polls registry propagation. `--dry-run` for preflight.
- Correct CI path (blocked, see P3): dispatch `publish.yml` with `ref: v<version>`
  and a non-`latest` dist-tag (prereleases are rejected on `latest`).
