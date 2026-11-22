# AGENTS.md

## Project overview

This repository is the scoped fork of `pi-hermes-memory`: Hermes-style persistent memory for Pi, plus a host-neutral, multi-tenant adapter under `src/scoped/`. The upstream engine is kept close to upstream; fork-specific behavior lives under `src/scoped/`, `tests/scoped/` and `docs/fork/`.

## Architecture

- **Language**: TypeScript. Source is shipped directly; `dist/` is generated at pack time for npm consumers.
- **Runtime**: Pi extension API (`@earendil-works/pi-coding-agent`) and an in-process host via the scoped provider port.
- **Storage**: Markdown memory files plus per-scope SQLite FTS5 mirrors under host-computed roots.
- **Entries**
  - `src/index.ts` — upstream/Pi extension entry
  - `src/scoped/entry.ts` — scoped tenant composition
  - `src/scoped/provider.ts` — npm-facing provider descriptor

## Layout

| Path | Role |
|---|---|
| `src/store/`, `src/tools/`, `src/handlers/` | Upstream engine — edit only when unavoidable |
| `src/scoped/`, `tests/scoped/` | Fork-owned adapter and its tests |
| `docs/fork/` | Fork-owned ledger, mapping, baselines and design records |
| `dist/` | Build artifact, gitignored |

## Where work is tracked

- `docs/fork/TASKS.md` is the single source of truth for current fork work, status and commit hashes.
- `docs/fork/UPSTREAM-MAPPING.md` defines what may change and why.
- `docs/fork/divergences.json` registers every upstream-file delta for the CI gate.

Read the tracker before deciding what to work on next. Do not keep task status in this file.

When asked "what's next", answer only from that tracker. Roadmap and proposal docs (for example `docs/0.7/PROPOSAL.md` and `docs/ROADMAP.md`) describe possible future work; mention them only when explicitly asked, and label them as not current work.

## Commands

```bash
npm run check                 # tsc --noEmit
TEST_TIMEOUT=400 npm test     # full suite; Windows needs the larger timeout
npm run upstream:check:ci     # fork-delta gate, no network
pi -e ./src/index.ts          # local Pi extension smoke
```

Run `npm run check` and the targeted test files before opening a PR. The full suite plus the fork-delta gate must be green before merge.

## Conventions

- Every repository uses PRs; never push directly to `main`.
- **Fork the boundary, not the engine.** Prefer injected parameters/config in fork-owned files over edits to `src/store/`, `src/tools/` or `src/handlers/`.
- Register any upstream-file change in `docs/fork/divergences.json` with an upstream baseline blob.

### Porting upstream behavior into `src/scoped/`

A scoped reimplementation is justified **only** by a constraint that makes the
upstream code unusable — never by convenience, preference, or an assumption of
better performance. If the upstream path could run, use it; a needless rewrite
is a fork defect, not a feature. Before writing scoped code that mirrors an
upstream handler, classify every difference:

| Class | Test | Required treatment |
|---|---|---|
| **Forced** | The upstream path is structurally unusable in-process: it spawns a process, reads `process.env`/`os.homedir()`, needs `model`/`modelRegistry` the host never passes, registers an inert rpc command, or assumes a project axis the tenant root replaces | Rewrite, and record the constraint in the file header |
| **Unforced drift** | Behavior or defaults diverge with no such constraint — a literal default copied by hand, a config field left unread, a threshold hardcoded | **Defect.** Delete the drift and read upstream's source of truth |
| **Additive** | A new option upstream does not have, in a fork-owned type, changing no upstream file | Allowed; document why |

Rules that follow from this:

- **Read upstream's config, do not copy its numbers.** Thresholds, budgets and
  limits come from `MemoryConfig` (e.g. `nudgeInterval`, `nudgeToolCalls`,
  `reviewRecentMessages`, `reviewEnabled`). A literal like `?? 6` next to a
  config field with a different value is drift, and it also makes the config
  field dead.
- **Reuse upstream's pure functions instead of re-deriving them.** Helpers such
  as `isCorrection()`, `collectMessageParts()`, `buildDirectReviewUserPrompt()`
  and the prompt constants are safe to import from `src/handlers/` and
  `src/constants.ts`; importing reads upstream, it does not modify it.
- **A capability the host injects must actually be honored.** If
  `reviewEnabled: false` reaches the tenant, review must not run. Shipping a
  switch that nobody reads is the same class of bug as inventing a default.
- **Only the forced list earns a divergence.** If a change touches no upstream
  file and adds nothing to `divergences.json`, it had better be either forced
  or additive — otherwise the fork is drifting for no reason.

When scoped behavior must differ because a forced constraint changes the
counting or timing model, say so explicitly in the design record and preserve
the upstream guard that the new model no longer gets for free (for example,
counting `turn_end` instead of user messages loses the implicit
`minUserTurns` protection and must re-add it as an option).
- The scoped adapter never reads `process.env` / `os.homedir()`, never spawns processes, and never touches credentials. The host owns those.
- Observability is best-effort: a metric sink must never change a tool result or break a memory operation.
- Tool-call metrics are installed with a Proxy at the entry boundary; upstream tool files stay untouched.
- Windows paths: derive expectations with `path.join`; dynamic ESM imports need `pathToFileURL().href`; `*` is illegal in directory names.

## Engine invariants

- Upstream entry injects a frozen memory snapshot at session start; do not mutate memory mid-session.
- Memory writes are atomic (temp file + rename).
- `§` is the entry delimiter, matching Hermes.
- Upstream session indexing reads Pi's `SessionManager`; the scoped adapter owns a per-scope SQLite FTS5 mirror.

## Releasing

Fork releases are **manual**, not via the upstream GitHub Actions release workflow:

1. Bump `package.json` and `PROVIDER_VERSION` in `src/scoped/provider.ts` together.
2. Update `CHANGELOG.md`.
3. Commit, tag, then run `node scripts/publish-scoped.mjs`.
4. Verify the `next` dist-tag on the official npm registry, not the local mirror.

See `docs/PUBLISHING.md` and `docs/fork/TASKS.md` for details and recovery paths.

## Security

- All memory/skill writes pass through `scanContent()` before persistence.
- `prepublishOnly` rejects credential-shaped files; keep secrets out of the package directory.
- Metric events contain status, duration, truncated error text and usage only — never memory content or prompts.

## Installation (for users)

```bash
pi install npm:@njuptlzf/pi-hermes-memory
```

## Gotchas

- **2026-11-21**: a full Windows `npm test` previously failed on POSIX-only path assumptions; fixed in PR #4. Keep using `path.join` / `pathToFileURL` for path-derived expectations.
- **2026-11-21**: work status lives only in `docs/fork/TASKS.md`; do not infer current work from other task files.
