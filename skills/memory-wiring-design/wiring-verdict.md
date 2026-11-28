# Wiring verdict framework — details

Companion to `SKILL.md`. Read when judging question 2 (semantic worth) or
re-checking a stale backlog verdict.

## Difference classification (the fork-side test)

When scoped code mirrors an upstream handler, classify **every** difference:

| Class | Test | Treatment |
|---|---|---|
| **Forced** | Upstream path structurally unusable in-process: import-time `process.env`/`os.homedir()`, subprocess spawn, project axis replaced by tenant root, inert RPC command, `model`/`modelRegistry` the host never passes | Rewrite in fork-owned files; record the constraint in the file header and design record |
| **Unforced drift** | Literal default copied by hand, config field left unread, threshold hardcoded | **Defect** — delete it and read upstream's source of truth. Never a "defer" reason |
| **Additive** | New option in a fork-owned type, no upstream file changed | Allowed; document why |

Rules that follow: read upstream config numbers (`MemoryConfig` fields), don't
copy them; reuse upstream pure functions (`isCorrection`, `collectMessageParts`,
`pruneOldSessions`, etc.) by import; a capability the host injects must actually
be honored (a switch nobody reads is the same class of bug as an invented default).

## Counterfactual gate (semantic worth)

Ask: **swap the current implementation for a different one — does the field/claim
still have complete meaning, and can a conformance assertion still be written?**

- `dataRetentionDays` → "N-day-old session content is no longer retrievable"
  survives any provider → **policy**, may enter the host contract.
- `nudgeMode` ("review counts turns vs tool calls") → a vector-memory provider
  has no review pace → **mechanism**, never in the contract; stays as provider config.
- A user-valuable capability with no behavioral restatement → reject or defer.

Second gate: **no real consumer, no reserved field.** A capability field with no
consumer is not "future-proofing" — it is an unenforced promise. Wait for a real
product demand, then re-enter with policy language, not the old mechanism name.

## C6 triad (host-side, when capability is asymmetric)

When a product may depend on a capability some providers lack:

1. provider declares `capabilities.<name>: true` (default false = unsupported;
   no "declare absence" tax on other providers);
2. product manifest declares `agent.memory.requires<Capability>` (a **dependency
   declaration**, not a switch — the host does not fabricate the capability);
3. host emits a mismatch warning at session creation, still opens the session.

Conformance pairs each capability boolean with an assertion. Cost lives in
contract maintenance (one boolean + one assertion per capability), not in every
provider declaring every absence.

## Scenarios where verdicts go stale

A verdict like "depends on #3–#4; nothing to index" becomes a **dead statement**
once #3/#4 land. Before acting on a backlog row, re-verify its rationale against
current code. Re-checking a queue is the cheapest place to catch a wrong verdict
before it mis-prioritizes work.

**Re-read the code path the rationale points to, not just the prerequisite
flags.** "#12: automatic consolidation already covers capacity" was overturned
by the overflow grace window itself — the store deliberately defers the auto
path during grace and tells the writer to consolidate manually, which no in-host
surface can do. A rationale that cites a mechanism must be checked against the
mechanism's current shape; a rationale whose blockers all landed is not the only
stale form.

Two historic false-verdict patterns:

- "Host doesn't call it" → invalid blocker; the point of wiring is often to add
  the host call surface (which then belongs to the host repo's contract work).
- "Auto-backfill already indexes, so a manual full reindex is redundant" → false
  when the upstream has two distinct paths (bounded incremental vs unbounded
  manual); verify by reading both call chains, not by name similarity.

## Merge-conflict avoidance

- Fork: register upstream-file deltas in `divergences.json` with a baseline blob;
  the CI gate (`npm run upstream:check:ci`) blocks unregistered changes. New
  fork-owned files must also be registered — the gate checks additions too.
- Host: add optional fields/methods at the port boundary; keep implementation
  facts (thresholds, file paths, provider names) out of protocol and core. The
  product/fixture owns product facts.
