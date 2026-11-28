---
name: memory-wiring-design
description: Guides wiring an upstream memory engine's capabilities into a multi-tenant fork — deciding technical feasibility, semantic worth, and source-repo/merge safety, writing design records, and configuring the wired capability. Use when asked whether an upstream/backlog capability should be wired into the fork, to write or review a fork wiring design record (docs/fork/*-DESIGN.md), to explain what is missing before wiring and gained after with scenarios, or to decide how to enable a wired capability via fork config. For wiring a third-party plugin INTO the agent-chat platform, use agentchat-plugin-wiring instead.
---

# Memory wiring design (fork side — toward the source repo)

This skill is for the **provider/fork side**: deciding whether and how to port a
capability from an upstream memory engine into a multi-tenant fork. Worked example:
`hermes-memory` (scoped fork of `pi-hermes-memory`). It is **not** for wiring a
plugin into the agent-chat platform — that is `agentchat-plugin-wiring`.

**Terminal output: a wiring design record.** A successful run does not stop at a
verdict — it produces `docs/fork/<TOPIC>-DESIGN.md` using
[design-record-template.md](design-record-template.md), plus a pointer in
`docs/fork/TASKS.md`. The four questions below feed that record's sections.

## When to invoke

- "Should we wire X?" / "what's the next unwired upstream capability?"
- Writing or reviewing a fork design record (`docs/fork/*-DESIGN.md`).
- Explaining what a capability adds, with concrete before/after scenarios.
- Deciding how to enable a wired capability in the fork (config knobs).
- Re-checking a backlog verdict after its prerequisites landed.

## Four questions — answer all with code evidence

| # | Question | Pass condition |
|---|---|---|
| 1 | **Feasible in the tenant boundary?** | An equivalent signal exists. Upstream path structurally unusable (import-time env/homedir, subprocess, project axis, inert RPC command, host-never-passed model) ⇒ **forced** rewrite, record the constraint. Otherwise reuse upstream's pure function; a hand-copied default or unread config field is a **defect**. |
| 2 | **Worth it?** | Restate in host-expected behavioral language; apply the provider-swap counterfactual (still meaningful + conformance writable?). Then check for a real consumer. Mechanism parameters never enter the host contract. |
| 3 | **Source-safe / merge-conflict safe?** | Fork the boundary, not the engine. Prefer injected config in fork-owned files; register every upstream-file delta in `divergences.json` with a baseline. Ask: after an upstream merge, how many conflict points? Zero is the target; >0 needs justification. |
| 4 | **Scenario proof** | Without: what concrete action fails/degrades today (`file:line`)? With: what works? Where does the improvement surface (prompt / retrieval / capability / admin)? |

Verdict format: `wire` / `defer (blocker: …)` / `reject (reason: …)`. Only a
forced constraint or a missing real consumer is a valid blocker — "the host
does not call it yet" is a to-do, not a blocker.

## Scenario template (fill verbatim)

```
Candidate: <name>
1. Feasible? equivalent signal <…> or forced constraint <…>, evidence <file:line>
2. Worth it? behavioral restatement "<…>"; swap-provider counterfactual <complete|broken>
3. Source-safe? upstream files touched <none|list + divergences row>; expected merge conflicts <0|N>
4. Scenario:
   - Without: <action that fails today>, evidence <file:line>
   - With: <same action works>; gained: <…>
   - Improvement surface: <…>, measured at: <test/interface>
Enablement: <config knob / port field / handle method + file:line>
```

## Fork-specific essentials

- **Enablement surfaces**: `ScopedMemoryTuning` (additive switches — must be read
  somewhere), `ctx.policy` (provider-neutral governance, outranks tuning),
  `ctx.history`/`ctx.complete` (host-injected ports; absent ⇒ degrade),
  `layout` (host-computed absolute roots), `capabilities` (declaration, default false).
  See [fork-landing.md](fork-landing.md).
- **Design record contract** (four mandatory elements): accurate cross-references
  with `file:line` checked *after writing*; concrete call chain including fields
  bypassing config at `mount()`; full impact surface including every caller of a
  changed signature (use inbound graph trace); explicit change risks including
  default-value decisions. Plus §0 "what this buys", facts, tests, ship order.
- **CI gate**: `npm run upstream:check:ci` — every new fork-owned file, **including
  a design doc**, needs a `divergences.json` row or the PR fails.
- **Status** lives in `docs/fork/TASKS.md`, not here. When asked "what's next",
  answer only from that tracker.

## Production flow (to the design record)

1. Read `docs/fork/TASKS.md` for the candidate's current verdict and prerequisites.
2. Answer Q1–Q4 with `file:line` evidence (use the code graph, not guesses).
3. Decide the enablement knob and locate its consumer site.
4. Write `docs/fork/<TOPIC>-DESIGN.md` from
   [design-record-template.md](design-record-template.md). Re-check every
   `file:line` **after** writing (§8 of the template).
5. Add a `divergences.json` row for the new file in the same PR.
6. Add a pointer in `docs/fork/TASKS.md` (status stays 延后/design-only until
   implementation lands).
7. PR base/head both `njuptlzf/pi-hermes-memory`; `npm run upstream:check:ci`
   must be green before merge.

## References

- [design-record-template.md](design-record-template.md) — **the output contract**:
  required sections, question→section map, completion checklist. Load before writing.
- [wiring-verdict.md](wiring-verdict.md) — forced/drift/additive, counterfactual
  gate, C6 triad, stale verdicts, merge-conflict avoidance. Read when judging Q2/Q3.
- [fork-landing.md](fork-landing.md) — config enablement, design-record contract,
  CI gate, a worked scenario example.
