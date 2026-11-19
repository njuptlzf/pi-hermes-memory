# Scoped fork backlog

Fork-owned file. Upstream does not know this path, so a merge never touches it.
Companion to `docs/fork/UPSTREAM-MAPPING.md` (what the fork is allowed to change)
and `docs/fork/F0-BASELINE.md` (the measured baseline).

Status verified 2026-11-19 on `main` (fork line graduated from `spike/f0-scoped-entry`).

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

Official npm state: `latest = 0.11.0-scoped.1` (untouched), `next = 0.11.0-scoped.4`.
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

## P0 — complete (2026-11-19)

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
reuse the same `runMemoryOps` runner — no upstream handler was modified.

Why this needed a contract change: these three need an LLM call, but their
existing paths both fail inside a host — `pi.exec()` subprocess is forbidden by
`extension-admission.ts`, and `DirectReviewContext` (model/modelRegistry) is
never passed to the scoped entry. The host contract now exposes an optional
`complete` callback; a provider without it simply skips background work.

## P1 — contract

- `capabilities.sharedProfile` not implemented. Decision 2026-11-18: **wait for
  the next upstream sync**, do not ship `0.11.0-scoped.2` just for the flag.
- No runtime warning when a product depends on cross-scope profile but selects a
  provider that does not support it (silently loses the capability).
- `scoped-memory` C1–C7 hardening not done (external repo, ownership TBD).

## P2 — engineering

- Observability: no trace_id, no success-rate / P95 / cost / tool-failure
  metrics for open/erase/tool calls.
- Hardening: only explicit provider-side limit is the 1200-char profile cap;
  timeouts / retries / rate limits all delegated to the host.
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
