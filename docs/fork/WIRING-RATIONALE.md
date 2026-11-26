# Why scoped wiring is incremental

Fork-owned file. Upstream does not know this path, so a merge never touches it.
Read this alongside `docs/fork/UPSTREAM-MAPPING.md` (what may change and why),
`docs/fork/WIRING-CONTRACT.md` (why we wire at all, what boundary the fork may
change, and what each capability buys), and `docs/fork/TASKS.md` (the single
source of truth for current status).

This is a design record, not a task list. It answers one question that keeps
coming up when someone compares `src/index.ts` with `src/scoped/entry.ts`:
**why does the scoped fork assemble fewer capabilities than upstream, and why
did those capabilities arrive one at a time instead of all at once?**

Short answer: nothing was lost and nothing was forgotten. The fork keeps the
engine intact and replaces the *entry*; the scoped entry may only assemble what
its host can legally support, and those supports became available in stages.

## 1. One engine, two entries

The fork did not rebuild hermes. It kept the entire engine — `src/store/`,
`src/tools/`, `src/handlers/` — with **zero changed lines and zero hunks inside
upstream functions** (measured in `F0-BASELINE.md`: 60 test files, 1,197 cases
preserved). Tenant safety arrives through injected roots and config, not through
edits to the engine. The design rule is stated at the top of `UPSTREAM-MAPPING.md`:
**fork the boundary, not the engine.**

What differs is the entry, because the two entries serve different hosts:

| | Upstream `src/index.ts` | Scoped `src/scoped/entry.ts` |
| --- | --- | --- |
| Host | single-user Pi CLI (a terminal) | in-process, multi-tenant server (agent-chat) |
| Owner of config / process / history / prompt | the CLI and the extension | the host, via the memory-provider port |
| Assembly | one 481-line default export wires everything | selects only what the host contract permits |
| Isolation boundary | one user, one machine | one store per scope, one profile per user |

So "fewer capabilities in scoped" is not a regression from forking. It is the
difference between a CLI that owns its whole environment and a library embedded
in a host that owns most of it. The host wiring is deliberately a *port*
(`UPSTREAM-MAPPING.md` §6): `selfInjects: false`, the host assembles the prompt,
and the fork exposes `promptSection()` / `erase()` / `dispose()` for the host to
call. Upstream's all-in-one entry would be the wrong shape here even if it could
be copied verbatim.

## 2. Three hard constraints decide what can be wired

The scoped entry's header states three constraints. They are host contract
requirements, not preferences — each one rules out a whole family of upstream
features:

1. **No `process.env` / `os.homedir()`.** Configuration belongs to the host.
   Anything that discovers a root from the environment would let one tenant's
   configuration leak into another's.
2. **No child-process spawn.** The host owns process lifetime. Upstream's review
   and flush run through `pi.exec()`; an in-process host rejects that. The scoped
   equivalent uses the injected `complete` callback instead.
3. **`registerCommand` is a no-op in rpc mode.** Upstream's TUI commands
   (`/memory-*`, `/learn-memory-tool`, …) have no caller in the host, so wiring
   them would be dead surface that only misleads.

A fourth consequence follows from the port: because the host assembles its own
prompt (`selfInjects: false`), prompt-side features must be exposed as data
(`promptSection()`) rather than injected by a hook.

These constraints are also enforced from outside: the host's
`extension-admission.ts` scans the declared extension file for `process.env`,
`os.homedir()`, `child_process` and TUI registrations. The scoped adapter is
built to pass that scan.

## 3. The wiring happened in stages, on purpose

Capabilities were mounted as their prerequisites became available. The commit
history is the evidence — this is a sequence, not a backlog that was forgotten:

| Commit | Capability wired | Prerequisite that made it possible |
| --- | --- | --- |
| `7c23d00` | tenant-safe entry (per-scope store, no env/globals) | injected roots + config |
| `0e18097` | cross-scope profile + capability-aware policy | two disjoint roots; a prompt builder that cannot lie |
| `ee3d8dd` | publishable package + provider descriptor | the host's memory-provider port |
| `cfa6254` | `memory_search` with a per-scope FTS5 mirror | per-scope `memoryDir` for the mirror to live under |
| `51aa48b` | auto-consolidation | host-injected `complete` callback (agent-chat `v0.8.0`) |
| `1cb50de` | background review + session flush | the same `complete` callback, via `runMemoryOps` |
| `6b3d47c` | per-turn automatic retrieval | the seeded per-scope mirror |
| `441444e` | observability + completion hardening | a stable tool boundary to instrument |

The clearest example is the `complete` callback. Consolidation, review and flush
all need an LLM call, but *both* upstream paths fail inside a host: `pi.exec()`
is forbidden, and the direct path needs a model/modelRegistry the scoped entry
never receives. Until the host added `createMemoryCompletion` to its port
(agent-chat PR #6, `v0.8.0`), those three capabilities had no legal transport.
They were wired in the moment that transport existed — not later because of
neglect, and not earlier by breaking the contract.

## 4. What is wired, and what is not

Already wired through the shared engine or the scoped adapter: persistent memory
and failure writes, `memory_search` with a per-scope FTS5 mirror, per-turn
retrieval, auto-consolidation / background review / session flush when `complete`
is injected, secret scanning, memory aging, extended store, metrics, `erase()`
and `dispose()`.

The remaining upstream surface was recorded as **22 candidates** and assessed on
2026-11-22 (see `TASKS.md`): **5 adopted and pending scheduling**, **7 deferred**,
**10 deliberately not done**. The verdicts are not "unknown" — each row has a
basis. The recurring pattern:

- **Deferred** means an external prerequisite is missing. Skills need a
  tenant-skill root from the host; a manual-consolidate trigger needs a host call
  surface, not a TUI command. Session search is **no longer deferred** — the
  per-scope session source arrived as the host's `history` port (agent-chat PR
  #17, `dcb07c3`) and was consumed by the backfill slice; only the #4 tail
  (retention / `session_files` metadata / ephemeral cleanup / recovery sidecar)
  remains open.
- **Not done** means the host design deliberately has no place for it. A project
  axis would reintroduce the shared dimension the host removed; TUI commands are
  inert in rpc; repair and migration commands have no gap to fill because tenant
  roots are host-computed and the FTS5 mirror is reconciled on every open.
- **Adopted** (#5 correction detection, #6 tool-call review nudge, #8 standing
  instructions, #21/#22 config passthrough) are **all complete** as of
  2026-11-23; see `TASKS.md` for commits. There is no "pending scheduling" backlog
  left among the adopted rows.

**Important correction (2026-11-26):** a missing host field or zero scoped calls
is **not** a reason to defer. It is the normal starting state of a wiring task —
the host contract is still unpublished and can be extended. The only admissible
blocker is a forced constraint with no tenant-safe equivalent (§2 above and
`WIRING-CONTRACT.md` §2–§3). "延后/不做" must name that constraint explicitly.

## 5. How to judge the current state

Do not infer "unwired" from a stale comment or from a feature's absence in the
full entry. Two rules:

1. **Status lives in `docs/fork/TASKS.md` only.** If a capability is scheduled,
   adopted, deferred or rejected, that file says so. This document records only
   the reasoning.
2. **A comment can lag the code.** The `src/scoped/entry.ts` header once claimed
   review and flush were excluded; they were already mounted through
   `src/scoped/review-flush.ts`. When in doubt, read the `mount()` body and the
   tracker, not the header.

The principle to carry forward is the same one that produced the fork: add a
capability when there is a legal host boundary to attach it to, and express it
as an injected parameter in a fork-owned file rather than an edit to the engine.
That is why the wiring is incremental, and why the increments keep the upstream
merge clean.
