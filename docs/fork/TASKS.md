# Scoped fork backlog

Fork-owned file. Upstream does not know this path, so a merge never touches it.
Companion to `docs/fork/UPSTREAM-MAPPING.md` (what the fork is allowed to change)
and `docs/fork/F0-BASELINE.md` (the measured baseline).

Status verified 2026-11-18 on branch `spike/f0-scoped-entry`.

## Done

| Item | Commit | Note |
| --- | --- | --- |
| Tenant-safe scoped entry (per-scope store, no env/globals) | `7c23d00` | |
| Cross-scope user profile + capability-aware policy | `0e18097` | |
| Publishable package + host-neutral provider descriptor | `ee3d8dd` | `@njuptlzf/pi-hermes-memory`, `hermes-scoped` |
| Publish under scoped name + credential guard | `32f3258`, `ce48f29` | `prepublishOnly` rejects credential-shaped files |
| Release smoke fix | `a505420` | tag `v0.11.0-scoped.1` |
| **`memory_search` wiring (per-scope FTS5 mirror)** | `cfa6254` | this branch's tip; see below |

`0.11.0-scoped.1` is live on the official registry (`latest` and `next` both
point at it). The local `npmmirror.com` mirror lags at `0.0.0-stage` — do not
use the mirror to judge publish state.

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

## P0 remaining — all blocked on one prerequisite

| Item | Status | Depends on |
| --- | --- | --- |
| Host LLM-injection contract | done in agent-chat (`feat/memory-llm-cap` `9ffca33`, pushed) | — |
| Auto-consolidation in scoped entry | done (`51aa48b`) | host `complete` callback |
| Background review in scoped entry | done (`1cb50de`) | same `complete` callback |
| Session flush in scoped entry | done (`1cb50de`) | same `complete` callback |
| Memory-quality eval set (24 cases) | done (`f8f67a2`) | — |

All four P0 capabilities are now wired. `runMemoryOps` is the shared runner;
review/flush add no divergence to upstream handlers. Eval baseline 100%.

The injection contract (`MemoryCompletion`: system+user → text, host owns
timeout/budget) landed in agent-chat's protocol + `session.ts` via
`createMemoryCompletion`, which adapts `modelRuntime.completeSimple` (same
model as the chat session, out-of-band from its history, no failover).
The scoped fork consumes it in `src/scoped/consolidation.ts`: bounded,
atomic-shrink, structured failure, no spawn/env/credentials. Review and flush
can reuse the same callback; they are the remaining P0 work.

Root cause: these three need an LLM call. Their existing implementations reach
one only through (a) `pi.exec()` subprocess — forbidden by
`extension-admission.ts` ("no spawn, no env" in a provider factory), or (b)
`DirectReviewContext` (`model` / `modelRegistry` / `sessionManager`), which the
full entry gets from `index.ts:360 runAutoConsolidation` but the scoped entry
never receives.

Host contract `packages/protocol/src/memory-provider.ts` exposes only
`storageRoot` / `sharedRoot` / `agentDir` / `scope` and
`factory` / `promptSection` / `erase` / `dispose` — **no completion/LLM field**.
Therefore this is contract extension, not wiring.

### Prerequisite: extend the host contract

1. Decide the injection shape (runJob-style callback: signature, timeout,
   permission, error type). Cross-repo change: agent-chat (worktree only) +
   this fork.
2. `[待核实: read packages/server/src/session.ts where the pi extension is
   constructed]` — confirm `model` / `modelRegistry` can be handed to the
   provider as a callback instead of building a new LLM client.
3. Implement the scoped consolidator against the injected capability, then
   reuse the same channel for review and flush.

## P1 — contract

- `capabilities.sharedProfile` not implemented. Decision 2026-11-18: **wait for
  the next upstream sync**, do not ship `0.11.0-scoped.2` just for the flag.
- No runtime warning when a product depends on cross-scope profile but selects a
  provider that does not support it (silently loses the capability).
- `scoped-memory` C1–C7 hardening not done (external repo, ownership TBD).

## P2 — engineering

- Eval set: existing ~35 cases are structural (tool registration, routing,
  erasure). No ≥20 memory-quality cases (recall, prompt injection, out-of-scope
  target, oversized input).
- Observability: no trace_id, no success-rate / P95 / cost / tool-failure
  metrics for open/erase/tool calls.
- Hardening: only explicit provider-side limit is the 1200-char profile cap;
  timeouts / retries / rate limits all delegated to the host.

## Known test flake

`tests/handlers/background-review.test.ts` has 2 timing-sensitive subtests
(`exec` call count 0↔1). Reproduced on a clean HEAD worktree — pre-existing,
unrelated to fork changes. It can fail the `verify` gate's `npm test`, so a
release dispatch may need a re-run.

## Release mechanics (fork line)

- `release.yml` **always checks out `main`**, whose `package.json` is
  `0.11.0` (upstream, no scoped code). Running it would publish the wrong
  package. Do not use it for the fork line.
- Correct path: bump `package.json` on `spike/f0-scoped-entry`, add the
  CHANGELOG section, tag `v<version>`, then dispatch `publish.yml` with
  `ref: <tag>` and a non-`latest` dist-tag (prereleases are rejected on
  `latest`).
