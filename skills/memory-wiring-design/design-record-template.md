# Output template — fork wiring design record

A successful run of `memory-wiring-design` produces **one file**:
`docs/fork/<TOPIC>-DESIGN.md` (also update `docs/fork/TASKS.md` with a pointer;
status stays in the tracker). This template is the contract — adapt names/sections
to the topic but keep every required element.

Map the four questions from SKILL.md into the record:

| SKILL.md question | Record section |
|---|---|
| Q1 feasible in tenant boundary | §1 Facts (forced/drift/additive classification) |
| Q2 semantic worth | §0 What this buys (behavioral restatement + counterfactual) |
| Q3 source-safe / merge-conflict safe | §3 Impact surface (upstream files + divergences rows) |
| Q4 scenario proof | §0 What this buys (without/with/improvement surface) |
| Enablement | §2 Call chain (how the knob reaches the code) + §7 Host reachability |

## Required sections

```markdown
# <Topic> design — <backlog #N ...>

> Fork-owned file. Design record per UPSTREAM-MAPPING.md §3.2 — an executable
> contract, not a sketch. Status: <design-only | implemented + commit/PR>.
> Companion to <related design records>. Per WIRING-CONTRACT.md §5, host-side
> wiring detail lives in the host repo — §7 states only what the fork needs.

## 0. What this buys
- Two/three bounded jobs or a single capability, stated in **host-expected
  behavioral language** (not mechanism names).
- **Scenario proof** (Q4): "Without: <action fails, file:line>. With: <works>.
  Improvement surface: <prompt / retrieval / capability warning>, measured at:
  <test/interface>."
- Counterfactual (Q2): swap the provider — does the claim still hold? If not,
  it is a mechanism and must not enter the host contract.

## 1. Facts (verified against <commit>, with file:line)
Numbered facts; for each upstream candidate classify:
- **forced** (structurally unusable: import-time env/homedir, subprocess, project
  axis, inert RPC command, host-never-passed model) → rewrite, cite constraint;
- **unforced drift** (copied default / unread config) → defect, delete it;
- **additive** (new option in fork-owned type) → allowed, document why.
Every fact carries a locator; no "we believe" / "probably".

## 2. Call chain — exact code shapes
Real TypeScript shapes, including fields that bypass the normal config object
and must be passed explicitly at `mount()`. Value flow as a fenced block.
New modules: full export signature. Config mapping: name the upstream field
(Chain A) vs a fork-only knob (Chain B) — never invent a number when an
upstream config field exists.
**Enablement**: which knob turns this on (`ScopedMemoryTuning` / `ctx.policy` /
`ctx.history` / `capabilities` / `layout`), with `file:line`, and where it is read.

## 3. Impact surface — every file and every caller
| File | Change | Ownership |
Enumerate callers of every changed signature using inbound graph trace.
List upstream files touched: **none** is the target. List `divergences.json`
rows needed (new file → new row; existing file → extend `change` text).

## 4. Risks
| ID | Risk | Decision / mitigation |
Include **default-value changes** explicitly: align + document, or keep +
justify as additive. Include teardown/concurrency and best-effort discipline.

## 5. Tests
Numbered cases with real assertions; **time anchors relative** (`now-6h`),
never literal calendar dates (a fixture that goes stale is a CI time-bomb).
State which face is probed (e.g. `searchSessions` for retrievability).

## 6. Ship order
Design → implementation (fails-then-passes) → `npm run check` → targeted tests
→ full suite (`TEST_TIMEOUT=400 npm test`) → `npm run upstream:check:ci` →
PR (base/head both `njuptlzf/pi-hermes-memory`) → TASKS.md update.

## 7. Host reachability (if a host contract field is needed)
Fork record declares what it needs; host-side wiring detail belongs to the
agent-chat repo (WIRING-CONTRACT.md §5). Show the ctx fold chain, capability
boolean, precedence (policy > tuning), and the layering rule: host verifies
declaration→ctx crossing, provider verifies behavior — never host reading
provider internals.

## 8. Cross-references checked (after writing)
| Claim | Source | Verified |
Re-check line numbers **after** writing; a stale anchor is a review finding.
```

## Completion checklist

- [ ] §0 contains a concrete without/with scenario with `file:line` on "without".
- [ ] Q1 classification (forced / drift / additive) stated per candidate.
- [ ] Q2 counterfactual verdict stated; mechanism parameters kept out of the host contract.
- [ ] Q3 upstream files touched = none; divergences rows enumerated.
- [ ] §2 enablement knob named and its consumer site located.
- [ ] §5 time anchors relative, not calendar dates.
- [ ] §8 every `file:line` re-verified after writing.
- [ ] New file gets a `divergences.json` row in the same PR (CI gate).
- [ ] Host-side record read and cross-checked (if one exists or is planned):
      contract names follow the host record, and every conformance assertion is
      answerable with "who observes this, on what face" — an assertion naming a
      host-visible string must have that string's content actually carrying the
      change (the #12 `promptSection` assertion failed exactly this and was
      corrected to the capacity face).
