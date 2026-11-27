# Scoped fork backlog

Fork-owned file. Upstream does not know this path, so a merge never touches it.
Companion to `docs/fork/UPSTREAM-MAPPING.md` (what the fork is allowed to change),
`docs/fork/F0-BASELINE.md` (the measured baseline) and
`docs/fork/WIRING-RATIONALE.md` (why capabilities are wired incrementally).

Status verified **2026-11-23** on `main` at `8937aae` (fork line graduated from `spike/f0-scoped-entry`).
Current fork tag: `v0.11.0-scoped.7`. P0–P2 are complete (P2 merged in PR #3, `f4407f7`);
all 5 adopted candidate rows are also complete.
The 22 candidate rows were assessed in order on 2026-11-22; the 5 adopted rows
(#5, #6, #8, #21, #22) were implemented 2026-11-22/23. P3 is now explicitly
lower priority than all of them. Earlier updates to the host contract and
capability flag are recorded inline.

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
| **Correction detection (candidate #5)** | — | `src/scoped/correction.ts`: `isCorrection` + injected `complete` via `runMemoryOps`, failure-memory capture, no subprocess/project/UI; shares a `BackgroundGate` with review/flush |
| **Review tuning (#6 + #21 + #22)** | — | Read `MemoryConfig` instead of the `?? 6` literal; `turn_end` counts `toolResults`; `nudgeMode` + `minUserTurnsBeforeReview` additive in fork-owned types; `ProviderContext.tuning` passthrough. Design `docs/fork/P4-TUNING-DESIGN.md`, tests `tests/scoped/tuning.test.ts` |
| **P5 PR-A — D1 duplicate injection + R8 `reviewEnabled` port gap** | PR #21, `344f412` | `src/scoped/prompt-blocks.ts` strips our own policy/profile/standing tags before appending the fresh section, in both pi branches; `tuning.reviewEnabled` folds into config (Chain A). Tests `tests/scoped/prompt-blocks.test.ts` (7 cases). No pin code. |
| **Standing instructions (candidate #8, P5 PR-B)** | PR #22, `feb9596` | `layout.standingFile` absolute beside `USER.md` (profile dir, scope fallback); `StandingInstructions` built iff enabled, lazy-loaded once, rendered last in `promptSection()`; `tuning.standingInstructions` → config. Prompt only — no write surface. Design `docs/fork/P5-STANDING-DESIGN.md`, tests `tests/scoped/standing.test.ts` (8 cases) |
| **#4 residual D — recovery sidecar convergence** | PR #36, `b7d5dc5` | `ready` chain awaits `store.maintainRecoveryFiles()` (layered facade → scope + profile roots). Upstream `runRecoveryMaintenance` avoided — its `listMemoryStoreDirs` walks `projectsRoot` (forced). Design `docs/fork/P6-SESSION-MAINTENANCE-DESIGN.md`, tests `tests/scoped/session-maintenance.test.ts` cases 1-3 |
| **#4 residual A — bounded retention prune** | PR #36, `b7d5dc5` | `src/scoped/session-retention.ts` calls pure `pruneOldSessions` in `withCorruptionRecovery`, kicked off before backfill; default `sessionRetentionDays=0` = no-op. No cursor writes — backfill's own equality skip keeps pruned-but-listed sessions absent. Same design record, tests cases 4-6 |
| **#4 A host reachability — `policy.dataRetentionDays`** | done — released in `0.11.0-scoped.9` (`v0.11.0-scoped.9`, squash `a43fd37`) | Fork reads host `ctx.policy.dataRetentionDays` (policy-first, fallback `tuning.retentionDays`) and folds into `config.sessionRetentionDays` (Chain A); declares `capabilities.dataRetention: true`. Tests: session-maintenance 7/8 + provider.test descriptor. Host side landed: agent-chat `MemoryPolicy` protocol + manifest + warning (PR #22, `b1e7bcd`; baseline docs PR #18–#21). Release note: PR #42's fixture hardcoded the "recent" session date and time-bombed the next day in CI — fixed in PR #44 (`257c641`, fixture derives freshness from now); case 9 (PR #46, `703e417`) pins the retrieval face — the pruned session's verbatim text no longer matches `searchSessions`, proving "no longer retrievable" on the surface `session_search` reads. Post-release queue CLOSED: agent-chat dep-bump `0.11.0-scoped.6→.9` + conformance pin `=== true` (their PR #23, `cd1c607`), fake-product fixture declares `policy: {dataRetentionDays: 365}` + `memory-policy-wiring.test.ts` end-to-end wiring check (their PR #24). Layering settled there: the host verifies declaration→ctx crossing only — never provider internals (§0 counterfactual; behavior lives in cases 4-9 above). |

Official npm state (verified 2026-11-27): `latest = 0.11.0-scoped.9`, `next = 0.11.0-scoped.9`.
Both tags were advanced to `.9` by hand after the release (same as `.8`); published prereleases may
be moved with `npm dist-tag add` even though `publish-scoped.mjs` refuses to
*publish* a prerelease directly under `latest`. Future releases keep using
`--tag next`, then promote `latest` explicitly if that build is to become the
default install.

**The package is fork-owned — "stable" can only mean a fork build.** Every
published version of `@njuptlzf/pi-hermes-memory` is on the `*-scoped.N` line,
starting at `0.11.0-scoped.1` (`ee3d8dd`, the fork's publishable-package commit).
The upstream source repository (`chandra447/pi-hermes-memory`) publishes a
*different package name*; nothing from upstream ever lands on this package's
`latest` or `next`. Both dist-tags therefore always select a fork build —
`0.11.0-scoped.1` is an older fork build, not "the upstream stable".
Moving `latest` back is a fork-version rollback, never a switch to upstream.
"Install the stable release" means "install the fork build we promoted"; the
`*-scoped.N` suffix marks the release line, not a perpetual beta.
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

## Backlog — upstream surface not wired into scoped (candidates, assessed)

Recorded 2026-11-21 by comparing the full Pi entry (`src/index.ts`) with the
scoped composition (`src/scoped/entry.ts` and `src/scoped/*`). Rows are still
**candidates, not current work and not a promise to implement**; the assessment
below records whether each one is worth doing, not a schedule. P3 sits after
this whole list. For the reasoning behind this staged, partial wiring — and why
it is deliberate rather than lost work — see `docs/fork/WIRING-RATIONALE.md`.

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

Housekeeping found during the comparison — **DONE**: the header comment in
`src/scoped/entry.ts` was corrected; it now documents that background review and
session flush are wired through `src/scoped/review-flush.ts` (and correction
detection through `src/scoped/correction.ts`), all sharing one background gate.

### Assessment (2026-11-22)

Verdicts follow the row order above. "采纳（待排期）" means the fork should do it
but it is not scheduled; "延后" means an external prerequisite is missing;
"不做" means the current host/fork design deliberately excludes it.

| # | Verdict | Basis / next step |
| --- | --- | --- |
| 1 | 延后 | `SkillStore` accepts an injected root, but the provider port has no skill-path exit and the host already owns discovery. Confirm a tenant-skill requirement before designing roots and registration. |
| 2 | 延后 | Depends on #1; without a tenant skill root there is nothing to migrate or discover. |
| 3 | **DONE 2026-11-25** (current-session slice) | `src/scoped/session-search.ts`: forks only the tool wrapper (upstream's imports `AGENT_ROOT` at import time — forced), reuses `searchSessions`/`getIndexedMessageCount`/`indexCurrentSession`; indexes the **current** session via `turn_end` + `session_shutdown`. Tool wording pinned to current-session scope (§4.2, test 10). `tuning.sessionSearch` opt-out (default on; agent-chat never passes tuning). Cross-tenant history still needs the host history port (§9 follow-up) — that is the remaining half of the old "per-scope session source" verdict. **Design: `docs/fork/SESSION-SEARCH-DESIGN.md`**, tests `tests/scoped/session-search.test.ts` (11 cases) |
| 4 | 延后 | Depends on #3; the whole index chain must use the same per-scope session source. |
| 5 | **DONE 2026-11-22** | `src/scoped/correction.ts`: `isCorrection` (pure, reused) + injected `complete` via `runMemoryOps`; failure-memory capture; no subprocess/project/UI. De-duplication via `BackgroundGate` shared with review/flush — all three use one slot. |
| 6 | **DONE 2026-11-23** | `turn_end` counts `event.toolResults.length`; `nudgeMode` (`turn`/`tool`/`either`, default `either`) in fork-owned `ScopedReviewFlushOptions`; no UI notification. **Design: `docs/fork/P4-TUNING-DESIGN.md`**, tests `tests/scoped/tuning.test.ts` |
| 7 | 不做 | The tenant root is the scope; a project axis would reintroduce the shared dimension the host deliberately removed. |
| 8 | **DONE 2026-11-23** (PR #21 D1/R8 + PR #22 #8) | **What it buys:** a short list of user-pinned rules injected into **every** request and marked as the user's own directive, so it holds without being asked. Nothing else in the tenant can do that: `MEMORY.md` is recalled only if the model chooses to search (fatal for prohibitions), auto-retrieval labels results "context, not instructions" and demotes them (`policy.ts:52-54`), and review/flush summarise after the fact. Measured: the retrieval router is English-only, so `我们之前是怎么处理 migrations 的` and 5/5 similar Chinese prompts do **not** trigger it — the automatic channel is effectively off for a Chinese-language host. **Scope:** point `StandingInstructions` at the file beside `USER.md` (`profileDir`, scope fallback) and render it from `promptSection()`; prompt only, no agent-authored writes (row #9 stays 不做). **Design: `docs/fork/P5-STANDING-DESIGN.md`** (2026-11-23), whose §0 states the feature, the gap, the benefit and the cost before any implementation detail. Three findings change the shape: `layout.standingFile` is a bare name and must be absolute; pins are **user-level**, beside `USER.md` (the first draft's scope-level answer was circular and was reversed at review); and the slice must first fix D1 — the section being injected twice on the host path. |
| 9 | 不做 | `registerCommand` is a no-op in rpc mode; if #8 lands, authoring belongs to a host/user-side surface, not an agent tool. |
| 10 | 不做 | The host can read memory files or use existing search; a TUI command has no rpc value. |
| 11 | 延后 | Depends on #1–#2; no skill store means no inventory to list. |
| 12 | 延后 | Automatic consolidation already covers capacity. A manual trigger needs a host call surface, not a TUI command. |
| 13 | 不做 | Onboarding belongs to the host/product; the command is inert in rpc. |
| 14 | 不做 | Depends on the already-excluded #7. |
| 15 | 不做 | Usage guidance belongs in host docs/prompt; no command needed. |
| 16 | 不做 | Scoped already reconciles the FTS5 mirror on every open, so the repair command has no gap to fill. |
| 17 | 不做 | The host can inspect the injected text by calling `promptSection()` directly. |
| 18 | 延后 | Depends on #3–#4; without a per-scope session source there is nothing to index. |
| 19 | 不做 | The host assembles its own prompt; `legacy-inject` conflicts with `selfInjects:false` and raises token/isolation risk. |
| 20 | 不做 | Tenant roots are host-computed, so upstream legacy migration sources do not exist; mirror reconciliation is the repair path. |
| 21 | **DONE 2026-11-23** | `ScopedMemoryTuning` on `ScopedHermesOptions` + `ProviderContext.tuning`; config-mapped fields fold into `MemoryConfig`, additive knobs (`nudgeMode`, `minUserTurnsBeforeReview`) are passed explicitly at the mount (design §4.2.1) |
| 22 | **DONE 2026-11-23** | `reviewEnabled`, `nudgeInterval`, `nudgeToolCalls`, `reviewRecentMessages` are now read by scoped code (were dead). Default `reviewRecentMessages` aligned to upstream `0` = all messages; see design risk R2 |
| 8 | **DONE 2026-11-23** | `docs/fork/P5-STANDING-DESIGN.md`. Both measured findings fixed: **D1** (section injected twice on the agent-chat path) in PR #21 via `src/scoped/prompt-blocks.ts`; **D2** (`layout.standingFile` was a bare name) in PR #22 — now absolute at the **user level** beside `USER.md` (`profileDir`, scope fallback), lazy-loaded, rendered last, **no write surface mounted** (row #9 stays 不做). 8 wiring tests in `tests/scoped/standing.test.ts` |

Summary: **5 采纳**（#5, #6, #8, #21, #22）, **7 延后**（#1, #2, #3, #4, #11, #12, #18）,
**10 不做**（#7, #9, #10, #13, #14, #15, #16, #17, #19, #20）. If work starts, take
adopted rows in numeric order; #21/#22 travel with #6.
**Done so far: #5, #6, #8, #21, #22 — all 5 adopted rows complete**
(2026-11-22 / 2026-11-23). #3 is now fully answered by the host history port (agent-chat PR #17,
`dcb07c3`) plus the scoped backfill slice (`SESSION-BACKFILL-DESIGN.md`):
`session_search` recalls previously saved sessions of this scope, not just the
live one. #4 residuals D (recovery sidecar convergence) and A (bounded retention
prune) are implemented 2026-11-26 per `P6-SESSION-MAINTENANCE-DESIGN.md` —
both fork-owned, default behavior unchanged. `session_files` materialisation and
orphan review-session cleanup remain unneeded: their capabilities are covered by
the backfill cursor + reconcile. The remaining 延后 rows are #1, #2, #4
(the two covered tails only, both judged unneeded), #11, #12, #18 — six numbered
rows, but only five actionable work items since #4's tails need no work. #8 landed
in two PRs per the design's §9 split:
**PR #21** fixed D1 (the section was injected twice on the agent-chat path) and
folded in R8's `reviewEnabled` port gap — same defect class, a policy switch a
provider-loaded host could not reach; **PR #22** wired user-level standing
instructions. The enable switch lives in `ScopedMemoryTuning` because upstream's
`standingInstructionsEnabled` is config-file-bound and unreachable from a
multi-tenant host; pins are **`user`-level**, beside `USER.md`, following that
person across their scopes. The first draft had said scope-level; the review
question "what does a rule pinned *for this course* even mean?" exposed that
argument as circular, and upstream's own placement (`STANDING.md` next to
`USER.md` in `globalDir`) settled it. Deferred and rejected rows are unchanged.

## P3 — CI auto-publish (deferred; lowest priority, after the 22 candidates)

**Decision: deprioritized.** Releases are cut by hand with
`node scripts/publish-scoped.mjs` (uses the machine's already-authenticated npm;
never reads or logs the token). CI OIDC publishing is blocked and not worth
the setup cost right now. This section is intentionally placed after the
candidate backlog and its assessment: P3 is lower priority than all 22 rows.

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

- `release.yml` **always checks out `main`**, whose `package.json` used to be
  `0.11.0` (the pre-fork version, before the fork introduced scoped packaging).
  Running it would publish the wrong package. Do not use it for the fork line.
- **All versions on npm are fork builds.** `@njuptlzf/pi-hermes-memory` is the
  fork's own package (created at `ee3d8dd`); upstream's source repo publishes
  under a different name. The `*-scoped.N` suffix is this fork's release line,
  not a signal that a non-fork "stable" exists. Promoting a build to `latest`
  makes it the default `npm install`; rolling back picks an older fork build.
- **Manual path (current)**: bump version + `PROVIDER_VERSION` together, add the
  CHANGELOG section, commit/tag, then run `node scripts/publish-scoped.mjs`.
  It uses the machine's `~/.npmrc` token for the official registry (reads only
  its presence, never the value), guards version drift / dirty tree / duplicate
  version / credentials, and polls registry propagation. `--dry-run` for preflight.
- Correct CI path (blocked, see P3): dispatch `publish.yml` with `ref: v<version>`
  and a non-`latest` dist-tag (prereleases are rejected on `latest`).
