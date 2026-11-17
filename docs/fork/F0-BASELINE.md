# F0 baseline — measured, not assumed

Measured 2026-11-17 on the F0 branch (`spike/f0-scoped-entry`) at upstream
`v0.11.0` (`ccdae89`), before any engine edit. The point of this file is to fix
the *denominator* for the decision rule: "tests green" has to mean something
concrete, or the gate argues with itself later.

## Environment

| Item | Value |
| --- | --- |
| OS | Windows 10.0.19045 (win32 x64) |
| Node | 22.22.2 (ABI 127), npm 10.9.7 |
| TypeScript | 6.0.3 (`npx tsc --noEmit` → **0 errors**) |
| MSVC | **absent** (no Visual Studio) |
| Install | `npm install --ignore-scripts` |

## Install note (why `--ignore-scripts`)

A plain `npm install` fails here: `better-sqlite3@13.0.3` ships no `install`
script, so npm falls back to `node-gyp rebuild`, which needs MSVC — absent.
The package already vendors prebuilt binaries in `prebuilds/win32-x64.node`, so
skipping scripts is not a workaround with a cost: `require('better-sqlite3')`
plus FTS5 (`create virtual table t using fts5`) was verified working after
`--ignore-scripts`. Nothing in the required path compiles.

## Test baseline

Runner used upstream's semantics (`node --import tsx --test <file>`, one process
per file), with a 90 s hard kill per file because upstream's `tests/run-all.sh`
aborts the whole run on the first failing file and would never reach the rest.

| Metric | Value |
| --- | --- |
| Test files | 60 |
| Test cases executed | 1,197 |
| Pass | 1,174 |
| Fail | 10 |
| Files that hang (killed at 90 s, no TAP output) | 1 |
| Typecheck | clean |

Per-file failures, all pre-existing at `v0.11.0` and all environment-shaped —
none of them touches a file this fork intends to modify:

| File | fails/total | Cause |
| --- | --- | --- |
| `tests/project-rebinding.test.ts` | hangs | blocks before emitting any TAP; killed at 90 s |
| `tests/store/sqlite-lazy-load.test.ts` | 2/2 | child process emits empty stdout — spawn/quoting of the module-graph probe on Windows |
| `tests/store/sqlite-native.test.ts` | 2/8 | ABI-mismatch rebuild path needs `node-gyp` → needs MSVC |
| `tests/handlers/pi-child-process.test.ts` | 2/54 | no `pi` binary on PATH (resolves to `node.exe`); `0o600` vs `0o666` file mode |
| `tests/handlers/background-review.test.ts` | 2/35 | `exec` never called on trigger (same missing-binary/exec-mock family) |
| `tests/handlers/skills-command.test.ts` | 1/29 | POSIX expectation `/tmp/valid/SKILL.md` vs `D:\tmp\valid\SKILL.md` |
| `tests/store/session-indexer.test.ts` | 1/58 | `excludeDirs` first-level scan, path-separator shaped |

## What "green" means for the F0 decision

Green = **no new failure versus this table**. Concretely, after each engine
change: 60 files run, ≥ 1,174 pass, and the 10 known failures (+1 hang) are
still exactly those, in the same files. A run that goes from 10 to 11 is a
regression even if the new failure looks unrelated.

This matters because upstream's own `npm test` is unrunnable on Windows as a
single command (fail-fast) — using it verbatim would have reported "2 failures
in 54 tests" and called the baseline unhealthy when the real number is 10 of
1,197.

## Decision-rule counters so far

| Counter | Value | Rule |
| --- | --- | --- |
| Upstream files modified | 1 (`package.json`, scripts block only) | ≤ ~15 to keep the fork |
| Upstream files added (fork-owned) | 5 | does not count against the fork |
| Hunks inside functions upstream edits | 0 | must stay 0 in `memory-store.ts` etc. |
| Engine lines touched | 0 | engine stays untouched by design (§3 of the mapping) |

Remaining before the gate can be decided: the five spike items (factory,
dual-root, routing guidance, concurrency rule, optional sqlite swap) and the
merge drill against the next upstream release.
