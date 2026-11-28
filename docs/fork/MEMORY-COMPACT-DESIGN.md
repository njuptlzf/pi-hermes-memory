# Memory compaction design — manual bounded-shrink surface (backlog #12)

> Fork-owned file. Design record per `UPSTREAM-MAPPING.md` §3.2 — an executable
> contract, not a sketch. Implements backlog **#12** (`/memory-consolidate`
> equivalent): a user/host-triggered one-shot shrink of the tenant's memory
> stores, through the already-mounted `consolidateViaCompletion` path. Companion
> to `SESSION-REINDEX-DESIGN.md` (sibling #18) — same ship shape, same host
> design record upstream: agent-chat `docs/design/记忆维护动作端口设计稿.md`
> (defines `compact()` + `capabilities.memoryCompaction`; this record follows
> that platform naming, unlike the #18 record's early `sessionReindex` drift).
>
> Status: design-only, not scheduled. Host-side port is designed; the fork
> handle method below is what the host will call once wired.

## 0. What this buys

- **Behavioral promise (host language)**: one call to `handle.compact()` brings
  each consolidated store back inside its capacity goal, or reports honestly
  why not — without waiting for the automatic thresholds.
- **Without (concrete, today)**: a write to a full store fails with
  `Memory at …` (`src/store/memory-store.ts:300-325`); when the overflow
  **grace window** is active (`overflowGraceActive`, `memory-store.ts:173-176`),
  the automatic consolidation is deliberately deferred and the error text
  instructs the caller to *"consolidate manually first"* — but in a host there
  is **no manual path**: upstream's `/memory-consolidate` is a
  `pi.registerCommand` (`src/handlers/auto-consolidate.ts:636`), inert in rpc
  mode (AGENTS forced class), and the scoped entry never mounts it. The grace
  window is a dead letter: the tenant can only retry-and-refuse until the
  window lapses. A second degraded mode: with no `complete` injected,
  consolidation never runs at all and stores only reject.
- **With**: host (or a direct `openScopedHermesMemory` user) calls `compact()`;
  memory and failure stores are walked once through the existing
  completion-backed path; subsequent writes succeed immediately.
- **Improvement surface**: the memory write path (`addWithConsolidation`
  overflow loop) and the bounded `promptSection()`; measured by §5's tests on
  `capacityUsage(target)` vs `capacityGoal(target)` (`memory-store.ts:135-149`),
  the same units the cap itself enforces.
- **Counterfactual (worth-it gate)**: any provider that can shrink its memory
  on demand can assert "after one call, usage ≤ goal (or honest failure)". The
  assertion does not name subprocesses, chunk budgets or merge algorithms —
  those are mechanism and stay inside this record. Verdict: **wire**.

## 1. Facts (verified against `2b65cef` via the cbm graph, 2026-11-28)

1. **The consolidator is capability-gated at mount.** `store.setConsolidator(...)`
   is called only when `complete !== undefined` (`src/scoped/entry.ts:548-550`),
   wrapping `consolidateViaCompletion(store, { target, complete, signal })`.
   Without a host completion, the overflow path has no consolidator at all.
2. **The only current trigger is overflow.** The injected `consolidator` is
   called from `MemoryStore.addWithConsolidation` (`memory-store.ts:335` area,
   guard chain `:314-325`) only after a `Memory at …` failure, only when
   `memoryOverflowStrategy() === "auto-consolidate"`, and only when the grace
   window is NOT active (`overflowGraceActive` returns the "consolidate
   manually first" deferral instead).
3. **Upstream's manual command is a forced class.** `registerConsolidateCommand`
   (`auto-consolidate.ts:626-725`) registers `memory-consolidate` via
   `pi.registerCommand` (inert in rpc), iterates an optional **project** target
   (`:659-665`, the axis row #7 rejects), and its heavy path
   `triggerConsolidation` (`:321-621`) uses `execChildPrompt` — a subprocess
   (`:438,:504`) the scoped adapter must never spawn. What survives the
   boundary check is the **intent**: iterate targets and shrink toward goal.
4. **The fork-owned single-prompt path already exists.** `consolidateViaCompletion`
   (`src/scoped/consolidation.ts:53-84`) takes `ScopedConsolidationOptions`
   (`:22-31`, `target: "memory"|"user"|"failure"` + injected `complete` +
   `signal`), calls `runMemoryOps` with `requireShrink: true` and
   `expectedTarget` filtering, and returns the shared `ConsolidationResult`
   (`src/types.ts:192-215`: `consolidated/error/partial/rounds/deferred`).
   **Reuse, do not rewrite.**
5. **Profile entries are never consolidated, by design.** The mount comment
   (`entry.ts:543-545`): the layered store routes the consolidator to the SCOPE
   store, which owns `memory`/`failure`; "the profile is capped small and never
   consolidated". Manual compaction must mirror this boundary — targets are
   exactly `["memory", "failure"]`.
6. **Healthy-store calls must cost nothing.** Upstream treats within-goal as a
   clean no-op (`{ consolidated: true, rounds: 0 }`, `auto-consolidate.ts:396`
   region). The fork equivalent compares `capacityUsage(target)` (`:147-149`,
   also on the layered facade `layered-store.ts:51`) against
   `capacityGoal(target)` (`:135-137`) before paying a completion.
7. **Concurrency has a ready-made slot.** One `createBackgroundGate()`
   (`src/scoped/background-gate.ts:22-34`) instance is currently created inside
   `mount()` (`entry.ts:551`) and shared by review/flush/correction. A manual
   `compact()` that writes while a review is mid-flight is exactly what the
   gate exists to serialize — but a handle method can be called before
   `mount()`, so the instance must be hoisted to `openWithRoots` (§2.3).
8. **Completion budgeting already applies.** The injected `complete` passes
   through `guardCompletion` (P2: 15s timeout, one transient retry, per-tenant
   serialisation) — the manual path inherits it; nothing new to add here.

## 2. Call chain — exact code shapes

### 2.1 New fork module — `src/scoped/compaction.ts`

```ts
import type { MemoryStore } from "../store/memory-store.js";
import type { MemoryCompletion } from "./completion-types.js";
import type { ConsolidationResult } from "../types.js";
import { consolidateViaCompletion } from "./consolidation.js";
import type { BackgroundGate } from "./background-gate.js";

export type CompactionTarget = "memory" | "failure";   // fact 5: never "user"

export interface ScopedCompactionResult {
  /** true when every claimed target pass completed (no-ops count as complete). */
  consolidated: boolean;
  /** set when the tenant has no completion capability — precondition miss. */
  skipped?: "no-completion";
  /** set when the background gate was busy — retry, not failure (mirrors
   *  ConsolidationResult.deferred semantics, types.ts:208-214). */
  deferred?: boolean;
  targets: ReadonlyArray<CompactionTargetResult>;
}

export interface CompactionTargetResult {
  target: CompactionTarget;
  consolidated: boolean;
  /** true when usage was already within goal — zero LLM cost (fact 6). */
  noop: boolean;
  error?: string;
}

export async function runScopedCompaction(
  store: MemoryStore,                       // the layered facade
  options: {
    complete?: MemoryCompletion;
    gate: BackgroundGate;
    signal?: AbortSignal;
    isDisposed: () => boolean;
  },
): Promise<ScopedCompactionResult> {
  if (!options.complete) return { consolidated: false, skipped: "no-completion", targets: [] };
  if (!options.gate.tryStart()) return { consolidated: false, deferred: true, targets: [] };
  try {
    const targets = (["memory", "failure"] as const).map((target) => {
      if (options.isDisposed()) return { target, consolidated: false, noop: false, error: "disposed" };
      const usage = store.capacityUsage?.(target);
      const goal = store.capacityGoal?.(target);
      if (typeof usage === "number" && typeof goal === "number" && usage <= goal) {
        return { target, consolidated: true, noop: true };          // fact 6: free no-op
      }
      return consolidateOne(store, target, options.complete!);       // §2.2, wraps fact 4
    });
    // sequential passes — one completion at a time, the guard already
    // serialises, and a memory pass that shrinks may make the failure
    // pass a no-op under the same tenant budget.
    const settled: CompactionTargetResult[] = [];
    for (const t of targets) settled.push(t);   // (implementation: awaits in order)
    return {
      consolidated: settled.every((t) => t.consolidated),
      targets: settled,
    };
  } finally {
    options.gate.finish();
  }
}
```

(Shape note for implementation: the per-target passes run sequentially inside
the single gate claim; the sketch above flattens that — the real module awaits
each `consolidateOne` before starting the next, and re-checks `isDisposed`
between passes. One claim for the whole call, not one per target.)

### 2.2 Per-target pass — pure reuse

```ts
async function consolidateOne(store, target, complete): Promise<CompactionTargetResult> {
  const result: ConsolidationResult = await consolidateViaCompletion(store, {
    target, complete, requireShrink: true /* already inside consolidateViaCompletion */,
  });
  return { target, consolidated: result.consolidated, noop: false, ...(result.error ? { error: result.error } : {}) };
}
```

No new prompt, no new LLM call shape, no new shrink semantics —
`consolidateViaCompletion` already applies `requireShrink` and target filtering
via `runMemoryOps` (fact 4). The `deferred` lock semantics of upstream's
subprocess path (file lock, `types.ts:208-214`) do not apply to the in-process
scoped path; the BackgroundGate is our equivalent and is claimed one level up.

### 2.3 Handle method + gate hoist

- `ScopedHermesHandle` (`entry.ts:193-218`) gains:

```ts
/** One-shot bounded compaction of the tenant's memory + failure stores
 *  (backlog #12). Skipped when no completion capability was injected;
 *  deferred when a background review/flush/correction holds the gate. */
compact(): Promise<ScopedCompactionResult>;
```

- **Gate hoist (the only refactor):** move `createBackgroundGate()` from
  `mount()` (`entry.ts:551`) up into `openWithRoots`, keep one instance per
  tenant, pass it into `setupScopedReviewFlush` /
  `setupScopedCorrectionDetector` exactly as today (they accept `options.gate`,
  `review-flush.ts:124`-region, `correction.ts:69`), and expose it to
  `compact()`. Single-tenant semantics unchanged — review/flush/correction
  still share one slot; a compact that arrives while one is running waits
  (defers), never races.
- `openWithRoots` closes over `complete` and the layered `store` — the same
  values the consolidator closure uses (`entry.ts:548-550`), so `compact()` is
  legal before `mount()` (fact: promptSection-only users already work with the
  same closures).

### 2.4 Provider surface

`provider.ts` mirrors the #18 landing, with the **host naming** already
adopted (no `sessionReindex`-style drift this time):

```ts
interface ScopedHermesProviderCapabilities {
  readonly sharedProfile?: boolean;
  readonly dataRetention?: boolean;
  readonly historyReindex?: boolean;      // #18 (rename from sessionReindex at its implementation)
  /** true = honours compact(): one call brings per-scope memory stores
   *  back within their capacity goal, via the injected completion. */
  readonly memoryCompaction?: boolean;
}
```

`open()` forwards into `ProviderSession`, mapped to the **host contract shape**
(`MaintenanceResult` per agent-chat `记忆维护动作端口设计稿.md` §2.2 — the host
record owns the shape; `compact()`'s richer per-target detail stays on the
handle method, the provider port narrows it):

```ts
// provider.ts, inside open():
compact: async () => {
  const r = await tenant.compact();
  return {
    affected: r.targets.filter((t) => t.consolidated && !t.noop).length,
    errors: r.targets.flatMap((t) => (t.error && !t.consolidated ? [`${t.target}: ${t.error}`] : [])),
    ...(r.skipped ? { skipped: true } : {}),
    ...(r.deferred ? { deferred: true } : {}),
  };
},
```

the capability object adds `memoryCompaction: true`. (Cross-check 2026-11-28:
without this adapter the two repos' result shapes silently diverge — exactly
the drift class the cross-repo check step exists to catch.)

## 3. Impact surface — every file and every caller

| File | Change | Ownership |
| --- | --- | --- |
| `src/scoped/compaction.ts` | **new** — §2.1/§2.2 | fork-owned (new `divergences.json` row) |
| `src/scoped/entry.ts` | gate hoist to `openWithRoots`; handle `compact()`; mount receives the hoisted gate | fork-owned |
| `src/scoped/provider.ts` | `capabilities.memoryCompaction`; forward `compact` | fork-owned |
| `tests/scoped/compaction.test.ts` | **new**: §5 | fork-owned (new row) |
| `docs/fork/TASKS.md` | #12 verdict → design record pointer | fork-owned (existing row, no new entry) |
| `docs/fork/MEMORY-COMPACT-DESIGN.md` | this record | fork-owned (new row) |

**Upstream files: none touched.** `consolidateViaCompletion` is fork-owned;
`capacityUsage`/`capacityGoal`/`ConsolidationResult` are import-read only;
`triggerConsolidation`/`registerConsolidateCommand` are **not imported** (their
subprocess/project/command trio is the forced set). Zero `divergences.json`
rows beyond the fork-owned files. Expected upstream-merge conflict points: **0**.

**Callers of changed signatures — enumerated:**
- `setupScopedReviewFlush(...)` / `setupScopedCorrectionDetector(...)`: already
  take an injected `gate` (`options.gate`), call sites pass the hoisted
  instance — signature unchanged, one call site each (`entry.ts` mount).
- `openScopedHermesMemory(options)`: handle interface widened additively
  (`compact()`); all 12 graph callers are provider + tests, none destructures.
- `provider.open(ctx)`: additive optional members; host-side structural typing,
  consumers ignore unknown members until their port slice lands (agent-chat
  design record §6 order).
- `MemoryStore.capacityUsage/capacityGoal`: already public reads (fact 6),
  existing callers `auto-consolidate.ts:393-395`; new callers in
  `compaction.ts` only.

## 4. Risks

| ID | Risk | Decision / mitigation |
| --- | --- | --- |
| R1 | **Default behavior change** — none: no new automatic trigger; `compact()` only runs when called; without `complete` it returns `skipped`. | Keep. The overflow-grace deferral (§0 "without") is untouched; the auto path and manual path now share the gate, which can only serialize more, never less. |
| R2 | **Single-prompt shrink ceiling.** `consolidateViaCompletion` sends the whole store in one prompt; upstream built a chunked subprocess loop precisely because that fails at cap scale (`auto-consolidate.ts:440-460` narrative). | Accepted for this slice, stated as semantics: a pass either shrinks atomically (`requireShrink`) or reports failure; **re-calling `compact()` makes further progress** (each call is a fresh pass over current disk state — progress that landed is on disk, cf. upstream "retrigger to continue" notes). Guarded by `guardCompletion` timeout; hosts that need big-store convergence call repeatedly (or wait for the auto path). Chunking stays a mechanism — if an eval set ever proves one-prompt insufficient, chunking lands here inside the fork, not in the contract. |
| R3 | **Gate starvation of the manual call.** `compact()` defers while review/flush/correction hold the slot; a chatty tenant could keep it busy. | Report `deferred: true` honestly (host surfaces retry guidance, mirroring `ConsolidationResult.deferred` semantics `types.ts:208-214`). Do not add priority-jumping — the shared slot is the whole point. |
| R4 | **The overflow-grace contract wording.** The deferral error says "consolidate manually first" — the manual path must actually clear the way for the next `add`. | Compact reduces `capacityUsage` below the cap check, so the next `_add` succeeds regardless of the residual grace timer. Test 5 drives exactly this loop. Grace state itself is not reset (that belongs to the store's own bookkeeping). |
| R5 | **failure-store consolidation churn.** The failure tier is small and aging; a manual pass over it could rewrite entries with no capacity pressure. | The within-goal no-op gate (fact 6) skips it whenever `capacityUsage("failure") ≤ capacityGoal("failure")`; LLM cost only when actually over goal. |
| R6 | **Profile ("user") accidentally included.** Upstream's command iterates user; our boundary forbids it (fact 5). | Type-level `CompactionTarget = "memory" | "failure"` — "user" does not compile. Test 6 asserts the user store is untouched. |

## 5. Tests — `tests/scoped/compaction.test.ts`

Mount shape: `openScopedHermesMemory({ storageRoot, sharedRoot, complete })`
with a scripted stub completion; real stores under temp roots; all time anchors
relative (per the 2026-11-27 lesson).

1. **Over-goal shrink**: memory store filled past goal; `compact()` → stub
   returns a shrink operation set; `capacityUsage("memory") ≤ capacityGoal`
   afterwards; result `consolidated:true`, targets list correct.
2. **Within-goal free pass**: healthy tenant → both targets `noop:true`,
   completion NOT called (spy count 0).
3. **No completion**: options without `complete` → `skipped: "no-completion"`,
   gate never claimed.
4. **Gate busy**: start a review (gate held), call `compact()` →
   `deferred:true`, no LLM calls; after `gate.finish()`, retry succeeds.
5. **Grace-window loop** (R4): drive `add` until the `Memory at …` failure with
   grace wording; `compact()`; next `add` succeeds.
6. **Profile untouched** (R6): user-store entries byte-identical after compact;
   no completion prompt contains `target: 'user'`.
7. **Shrink enforcement**: stub returns non-shrinking ops → pass reports
   `consolidated:false` with error; store unchanged (requireShrink guard
   already tested in P0 suite — here only the mapping is checked).
8. **Disposed mid-pass**: dispose after first target → second target
   `error:"disposed"`, `consolidated:false`, no closed-handle throw.
9. **Descriptor**: `capabilities.memoryCompaction === true`
   (provider.test.ts pattern, like `dataRetention`).

## 6. Ship order

1. This record (merged, design-only).
2. Implementation PR: `compaction.ts` + gate hoist + handle + provider + tests
   (fails-then-passes), `npm run check`, targeted tests,
   `TEST_TIMEOUT=400 npm test`, `npm run upstream:check:ci`.
3. Host slice (agent-chat repo): port method `compact()` + capability warning —
   already designed in `记忆维护动作端口设计稿.md`; fork releases under the new
   `*-scoped.N` first, host bumps after.
4. `TASKS.md` #12 graduate to done on implementation merge.

## 7. Host reachability

Per the platform record (`记忆维护动作端口设计稿.md` §2.2/§3): the host calls
`session.compact?()` when the product declares `requiresMemoryCompaction` and
the provider declares `capabilities.memoryCompaction`. Host conformance stops
at **call arrival + capability/dependency warning behavior** (spy provider);
the shrink behavior itself is proven by §5 here — the host must never open the
tenant's stores. Naming is already aligned (`compact` / `memoryCompaction`);
the #18 record's `sessionReindex` drift is renamed at its own implementation
time to the platform name `historyReindex`.

## 8. Cross-references checked (after writing)

| Claim | Source | Verified |
| --- | --- | --- |
| consolidator mounted only with complete, at entry | `src/scoped/entry.ts:548-550` | yes |
| overflow-only trigger + grace deferral wording | `memory-store.ts:300-325,173-176` | yes |
| upstream manual command = registerCommand + project + subprocess | `auto-consolidate.ts:636,659-665,438,504` | yes |
| consolidateViaCompletion reusable (requireShrink, targets) | `consolidation.ts:22-31,53-84` | yes |
| profile never consolidated by design | `entry.ts:543-545` comment | yes |
| within-goal = clean no-op upstream precedent | `auto-consolidate.ts:396`-region `{consolidated:true, rounds:0}` | yes |
| capacityUsage/capacityGoal public reads | `memory-store.ts:135-149`, `layered-store.ts:51-52` | yes |
| gate instance created in mount, shared by review/flush/correction | `entry.ts:551`, `background-gate.ts:22-34` | yes |
| ConsolidationResult deferred semantics | `types.ts:192-215` | yes |
| guardCompletion bounds apply to injected complete | `completion-guard.ts` (P2) | yes |
| host naming compact/memoryCompaction | agent-chat `记忆维护动作端口设计稿.md` §2.2/§3 | yes |
