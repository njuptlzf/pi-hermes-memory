# Fork-side landing — enabling a wired capability in a multi-tenant memory fork

Worked example: `pi-hermes-memory` scoped fork (`hermes-memory`). Adapt names to
the fork in question; the shape is the point.

## Enablement surfaces (where to configure "on")

| Surface | Use for | Evidence |
|---|---|---|
| `ScopedMemoryTuning` on `ScopedHermesOptions` | Additive knobs and switches unreachable from upstream config (upstream config is often AGENT_ROOT-bound). Each field must be **read** by scoped code. | `src/scoped/entry.ts` interface + `provider.ts` `ProviderContext.tuning` forward |
| `ProviderContext.policy` | Host data-governance requirements (provider-neutral language), e.g. `dataRetentionDays`. Folded into upstream `MemoryConfig` via Chain A; **policy outranks tuning**. | `provider.ts` `capabilities` + `entry.ts` Chain A fold |
| `ProviderContext.history` / `complete` | Host-injected ports (session history, LLM completion). Absent ⇒ provider degrades (current-session only / no background work). | `src/scoped/history-types.ts`, `completion-types.ts` |
| `layout` fields | Tenant roots (memoryDir, standingFile, …); host-computed absolute paths only. | `src/scoped/entry.ts` `ScopedLayout` |
| `capabilities` declaration | Tell the host what this provider actually honors; default false. | `src/scoped/provider.ts` |

Rule: an enable field that nothing reads is a defect. After adding one, verify the
consumer site and add a test that fails if the field is dropped.

## Design-record contract (four mandatory elements)

A record under `docs/fork/*-DESIGN.md` is an implementation contract, not a sketch.
Before writing scoped code it must contain all four:

1. **Accurate cross-references** — §numbers, symbols, paths, `file:line` **checked
   after writing**.
2. **Concrete call chain** — real code shapes, including fields that bypass the
   normal config object and must be passed explicitly at `mount()`.
3. **Full impact surface** — every file, plus every caller of a changed signature
   (use the code graph's inbound trace, don't guess).
4. **Explicit change risks** — including default-value changes: state the decision
   (align + document, or keep + justify as additive).

Also include: §0 "what this buys" (the scenario proof from SKILL.md), facts with
locators, tests, ship order, and the host-reachability section if a host contract
field is needed (fork record declares what it needs; host-side wiring detail lives
in the host repo).

## CI gate (do not skip)

`npm run upstream:check:ci` blocks any registered-or-unregistered mismatch. A new
fork-owned file — **including a design doc** — must get a `divergences.json` row
(`status: applied`, `surface`, `change`, `reason`, `risk: new`, `anchors: []`,
`baseBlob: null`). A docs-only PR with a new file fails the fork-delta check
without this row; add it in the same PR.

## Scenario example (shape, fork #18)

- **Without**: `startScopedHistoryBackfill` caps at 50 sessions per open
  (`BACKFILL_SESSIONS_PER_OPEN`), so a user with hundreds of saved sessions cannot
  make old sessions searchable on demand; no handle method exists to request it.
- **With**: `reindexSessions()` on the handle runs one unbounded pass through the
  host history port, guarded by retention so pruned sessions are not silently
  re-added (the load-bearing risk).
- **Improvement surface**: `session_search` recall; measured by a test that probes
  the retrieval face after a full pass.
- **Enablement**: host declares `capabilities.historyReindex`; direct users call
  the handle method. No upstream file changes.
