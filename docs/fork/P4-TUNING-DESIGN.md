# P4 tuning design — scoped review policy (#6 / #21 / #22)

> **Status: proposal.** Not implemented yet. This record is written before the
> code so the reasoning is reviewable on its own, following the precedent of
> `docs/fork/P2-OBSERVABILITY-DESIGN.md`.
>
> Candidates covered, from `docs/fork/TASKS.md`: **#21** (provider option
> passthrough), **#22** (review/flush config surface), **#6** (tool-call-aware
> review nudge). They ship as one slice because #6 has no meaning without the
> knobs from #21/#22.

## 1. Problem

The scoped entry mounts background review with a hardcoded threshold and
ignores the host's configuration. Three separate defects, one root cause —
scoped code restated upstream behavior instead of reading it:

1. **A copied literal.** `src/scoped/review-flush.ts` uses
   `options.reviewEveryTurns ?? 6`. Upstream uses `config.nudgeInterval`,
   whose default is **10**. There is no multi-tenant reason for 6; it is
   unforced drift (see `UPSTREAM-MAPPING.md` §3.1).
2. **Dead config.** `src/scoped/entry.ts` passes only `{ store, complete, gate }`
   to `setupScopedReviewFlush`, so `config.nudgeInterval`,
   `config.nudgeToolCalls`, `config.reviewRecentMessages` and
   `config.reviewEnabled` are never read by any scoped code. A host that sets
   `reviewEnabled: false` still gets reviews — a switch nobody reads is a bug.
3. **A missing signal.** Scoped counts only user messages
   (`message_end`, `role === "user"`). Upstream also counts tool calls, so a
   long tool-driven task — 20 tool calls, 2 user messages — never reaches the
   review threshold at all. That work is silently never summarized into memory.

## 2. Goals and non-goals

**Goals**

1. Read thresholds from `MemoryConfig` — no copy of upstream's numbers.
2. Honor `reviewEnabled` and `reviewRecentMessages`.
3. Add tool-call awareness so tool-heavy sessions still get reviewed.
4. Expose the knobs to the host through the provider port.
5. Touch **zero upstream files**; add nothing to `divergences.json`.

**Non-goals**

- No change to `src/types.ts`, `src/config.ts` or `src/handlers/` — all three
  are upstream files (only `config.ts` is registered as diverged, and only for
  `defaultMemoryConfig()`).
- No new UI notification. The scoped provider does not notify (see #6's
  verdict; host owns UI).
- No project dimension. There is no project store in a tenant.
- No change to consolidation or correction triggering beyond sharing the gate.

## 3. The counting question: 6 and 10 are not comparable

This is the subtlest part of the design and the reason the old literal was
wrong in a way a code review would miss.

| | scoped today | upstream |
| --- | --- | --- |
| Counter site | `message_end`, `role === "user"` | `turn_end`, every assistant turn |
| Unit | **user messages** | **assistant turns** (including tool loops) |
| Default | 6 | `nudgeInterval` = **10** |

One user request that runs three tool loops increments upstream **3** times and
scoped **1** time. So "6 → 10" is not a threshold change; it is a **different
ruler**. Any statement of the form "scoped reviews less often than upstream"
is false until both are measured in the same unit.

Consequences for the design:

- The threshold's meaning is defined by the counting mode, not by the number.
  `nudgeInterval: 10` means "10 assistant turns" under `turn`/`either`, and is
  irrelevant under `tool`.
- Because the unit changes, the implicit guard described in **§5.1** disappears.

## 4. Option surface

All new options are **additive** and live in fork-owned types. Nothing is added
to `MemoryConfig`.

### 4.1 `ScopedReviewFlushOptions` (`src/scoped/review-flush.ts`)

```ts
export type NudgeMode = "turn" | "tool" | "either";

export interface ScopedReviewFlushOptions {
  readonly store: MemoryStore;
  readonly complete: MemoryCompletion;
  readonly gate?: BackgroundGate;
  /** Upstream config source. Thresholds are read from it, not restated. */
  readonly config?: MemoryConfig;
  /**
   * Which counter may trigger a review. Default "either" (upstream semantics):
   * turn OR tool-call threshold, whichever is met first.
   */
  readonly nudgeMode?: NudgeMode;
  /**
   * Minimum user messages before any review. Default 3.
   *
   * Required because counting turns instead of user messages removes the
   * implicit protection the old code got from `userTurns < 6`: a single long
   * tool-driven turn can satisfy the turn/tool threshold while the user has
   * said one sentence, which writes noise into memory.
   */
  readonly minUserTurnsBeforeReview?: number;
  readonly reviewEveryTurns?: number;   // overrides config.nudgeInterval
  readonly nudgeToolCalls?: number;     // overrides config.nudgeToolCalls
  readonly recentMessages?: number;     // overrides config.reviewRecentMessages
}
```

**Precedence, per field:** explicit option → `config` value → upstream default
constant. The explicit option exists for direct `openScopedHermesMemory` users
and tests; the config path is the normal host path. There is no fourth source
and no scoped-only literal.

### 4.2 `ScopedHermesOptions` (`src/scoped/entry.ts`) — #21

```ts
export interface ScopedMemoryTuning {
  /** Forwarded to the review/flush/correction mount. */
  readonly nudgeMode?: NudgeMode;
  readonly minUserTurnsBeforeReview?: number;
  readonly reviewEveryTurns?: number;
  readonly nudgeToolCalls?: number;
  readonly recentMessages?: number;
  /** Already supported by the entry, previously unreachable from the port. */
  readonly injectPrompt?: boolean;
  readonly autoRetrieve?: boolean;
  readonly retrievalBudget?: RetrievalBudget;
  readonly profilePromptChars?: number;
}

export interface ScopedHermesOptions extends ScopedRootInput {
  // ...existing fields...
  /** Host-supplied policy knobs. Merged under `config`; never read from disk. */
  readonly tuning?: ScopedMemoryTuning;
}
```

The entry folds `tuning` into the config it already builds:

```ts
const config: MemoryConfig = {
  ...defaultMemoryConfig(),
  ...options.config,
  ...(options.tuning?.reviewEveryTurns !== undefined
    ? { nudgeInterval: options.tuning.reviewEveryTurns } : {}),
  ...(options.tuning?.nudgeToolCalls !== undefined
    ? { nudgeToolCalls: options.tuning.nudgeToolCalls } : {}),
  ...(options.tuning?.recentMessages !== undefined
    ? { reviewRecentMessages: options.tuning.recentMessages } : {}),
  memoryDir: layout.memoryDir,
};
```

### 4.2.1 Full call chain — exact code shapes

There are **two different transports** for tuning values. Confusing them is
the "switch nobody reads" bug, so the chain is written out in full:

**Chain A — fields that exist in `MemoryConfig`** (`nudgeInterval`,
`nudgeToolCalls`, `reviewRecentMessages`, `reviewEnabled`):

```
ProviderContext.tuning.reviewEveryTurns
  → provider.open(): openScopedHermesMemory({ ..., tuning: ctx.tuning })
  → entry.openWithRoots(): config = { ...defaultMemoryConfig(), ...options.config,
        nudgeInterval: options.tuning.reviewEveryTurns ?? config.nudgeInterval, ..., memoryDir }
  → entry.mount(): setupScopedReviewFlush(pi, { store, complete, gate, config })
  → review-flush.turn_end: const nudgeInterval = options.reviewEveryTurns ?? config.nudgeInterval
```

**Chain B — additive fields with no `MemoryConfig` counterpart**
(`nudgeMode`, `minUserTurnsBeforeReview`). These **cannot** be folded into
`config`; if that is attempted they are silently dropped. They must be passed
explicitly at the mount site, which is the only production caller:

```
ProviderContext.tuning.nudgeMode
  → provider.open(): openScopedHermesMemory({ ..., tuning: ctx.tuning })
  → entry.mount():
      setupScopedReviewFlush(pi, {
        store, complete, gate, config,
        nudgeMode: options.tuning?.nudgeMode,                          // explicit
        minUserTurnsBeforeReview: options.tuning?.minUserTurnsBeforeReview, // explicit
      });
  → review-flush.turn_end: const nudgeMode = options.nudgeMode ?? "either"
```

Chain B has exactly **one production call site**. Verified by grep:
`src/scoped/entry.ts:350` is the only caller outside tests. The seven test
call sites in `tests/scoped/review-flush.test.ts` omit both fields and must
continue to work on the defaults — hence both remain optional.

Failure mode to guard against: adding `nudgeMode` to `ScopedMemoryTuning` and
`ScopedReviewFlushOptions` but not to the `entry.ts` mount call. Type checking
will not catch it (both fields are optional), tests for Chain A will still
pass, and the host's setting will be silently ignored. §7 test 10 exists
specifically to fail in that case.

### 4.3 `ProviderContext` (`src/scoped/provider.ts`) — #21

```ts
interface ProviderContext {
  // ...existing fields...
  /** Policy knobs forwarded to the tenant. Optional; absent = upstream defaults. */
  readonly tuning?: ScopedMemoryTuning;
}
```

`open()` passes it straight through. The provider still imports no host SDK;
`ScopedMemoryTuning` is a structural shape.

### 4.4 Effect on #22 review/flush config surface

With the above, these become live:

| Config field | Where it is read | Was it read before? |
| --- | --- | --- |
| `reviewEnabled` | `turn_end` and `session_shutdown` in review-flush | **no** |
| `nudgeInterval` | turn threshold | **no** |
| `nudgeToolCalls` | tool threshold | **no** |
| `reviewRecentMessages` | `collectMessageParts` limit | **no** |

`flushMinTurns` / `flushRecentMessages` are **not** wired in this slice: flush
already runs at most once and only when `userTurns > 0`. Wiring them would add
knobs with no observed need; noted as a non-goal rather than a silent gap.

**Default-value decision for `reviewRecentMessages` (explicit):** scoped
currently uses `options.recentMessages ?? 20`; upstream's
`DEFAULT_REVIEW_RECENT_MESSAGES = 0`, and `applyRecentMessageLimit(parts, 0)`
returns **all** parts. Making the config field live therefore moves the
effective default from "last 20 messages" to "all messages". **Decision: align
with upstream (0 = all).** Rationale: the standard in `UPSTREAM-MAPPING.md` §3.1
forbids diverging on a performance assumption, and 20 was an unforced literal
with no recorded justification. The cost consequence is recorded in §8 risk
R2, and a host that wants the old bound can set `tuning.recentMessages: 20`.
This is a deliberate behavior change, not an accidental one.

### 4.4.1 Callers of changed signatures

| Symbol | Call sites | Treatment |
| --- | --- | --- |
| `setupScopedReviewFlush(pi, options)` | `src/scoped/entry.ts:350` (production); `tests/scoped/review-flush.test.ts` ×7 | Production updated with `config` + Chain B fields. Tests keep omitting the new optional fields and exercise defaults; new dedicated tests added in `tests/scoped/tuning.test.ts` |
| `openScopedHermesMemory(options)` | `src/scoped/provider.ts:100` (production); `tests/scoped/*.test.ts` | `tuning` is optional, so existing callers are source-compatible |
| `ProviderSession` / `provider.open()` | agent-chat `memory-providers.ts` (structural) | Additive optional field; no host change required |

All three are fork-owned signatures. **Upstream files checked for accidental
edits:** `src/types.ts`, `src/handlers/background-review.ts`,
`src/handlers/message-parts.ts`, `src/config.ts` — none is modified by this
slice; `src/config.ts` was already diverged before this work and gains no new
hunk. `docs/fork/divergences.json` gains **no** code entry (only the design
document entry already registered).

## 5. Counting implementation

```ts
let userMessages = 0;      // message_end, role === "user"
let turnsSinceReview = 0;  // turn_end
let toolCallsSinceReview = 0;

pi.on("message_end", (e) => { if (e.message?.role === "user") userMessages++; });

pi.on("turn_end", async (event, ctx) => {
  turnsSinceReview++;
  toolCallsSinceReview += event.toolResults?.length ?? 0;   // TurnEndEvent has toolResults

  if (config.reviewEnabled === false) return;
  if (userMessages < minUserTurns) return;                  // §5.1

  const byTurn = turnsSinceReview >= nudgeInterval;
  const byTool = toolCallsSinceReview >= nudgeToolCalls;
  const due =
    nudgeMode === "turn" ? byTurn :
    nudgeMode === "tool" ? byTool :
    byTurn || byTool;                                       // "either"
  if (!due) return;
  if (!gate.tryStart()) return;
  // ...existing review body...
  turnsSinceReview = 0; toolCallsSinceReview = 0;
});
```

`event.toolResults` is typed on `TurnEndEvent` in both `pi-coding-agent@0.80.2`
(this repo) and `@1.5.2` (agent-chat), and `agent-session.js` forwards it
verbatim. Reading it is upstream data, not an upstream edit — and it is more
reliable than upstream's own `message.content` scan, which misses nothing but
requires block-shape assumptions.

### 5.1 Why `minUserTurnsBeforeReview` must exist

Under the old model the guard was free: the counter *was* the user-message
count, so `userTurns < 6` already implied "at least 6 user messages". Counting
turns removes that implication — one turn with 15 tool calls satisfies
`either` while the user has spoken once. Upstream carries the equivalent guard
explicitly (`background-review.ts:225`, `if (userTurnCount < 3) return;`).

So this is not "adding a feature upstream lacks"; it is **preserving a guard the
new counting model no longer inherits**. Default 3 matches upstream. The guard
applies to every mode, not only `either`: under `turn` mode, three assistant
turns can also occur within one user message.

## 6. Files touched

| File | Change | Upstream? |
| --- | --- | --- |
| `src/scoped/review-flush.ts` | read config, add mode + min-user-turns, count toolResults | fork-owned |
| `src/scoped/entry.ts` | fold `tuning` into config; pass `config` to review-flush | fork-owned |
| `src/scoped/provider.ts` | `ProviderContext.tuning` passthrough | fork-owned |
| `tests/scoped/tuning.test.ts` | new coverage | fork-owned |
| `docs/fork/TASKS.md` | #6/#21/#22 status | fork-owned |
| `AGENTS.md` | (already carries the porting standard) | diverged, registered |

**No upstream file is modified. `divergences.json` gains no entry.**

## 7. Tests

`tests/scoped/tuning.test.ts`, mounting the real handler on a fake pi:

1. **Config is read, not restated** — `nudgeInterval: 2` triggers at 2 turns;
   a scoped literal of 6 would fail this.
2. **`reviewEnabled: false` stops review** — no completion call.
3. **`reviewRecentMessages` bounds the prompt** — only the last N parts appear.
4. **`nudgeMode: "turn"`** — many tool calls alone does not trigger.
5. **`nudgeMode: "tool"`** — tools alone triggers without reaching turns.
6. **`nudgeMode: "either"`** (default) — whichever comes first triggers.
7. **`minUserTurnsBeforeReview`** — a tool-heavy turn with 1 user message does
   not review; after the third user message it does.
8. **Precedence** — explicit option beats config beats default.
9. **Gate still shared** — a held gate leaves counters intact for the next turn.
10. **Chain B is actually wired** (`nudgeMode` + `minUserTurnsBeforeReview`) —
    assert through the **entry mount**, not by calling `setupScopedReviewFlush`
    directly: mount a handle with `tuning: { nudgeMode: "tool" }`, fire a turn
    with many `toolResults` and few assistant turns, and confirm a review
    happened. A design/impl that only adds the type fields but forgets the
    `entry.ts` mount call will fail here and pass tests 1-9.

## 8. Risks

| ID | Risk | Mitigation / decision |
| --- | --- | --- |
| R1 | Behavior change: review may fire more often under `either` | Documented; host sets `nudgeMode: "turn"` to keep the old cadence |
| R2 | **Default-value change:** `reviewRecentMessages` effective default moves from scoped's `20` to upstream's `0` (all messages), so the review prompt can grow substantially in long sessions and cost more per completion | **Intentional alignment** per §4.4; a host can restore the old bound with `tuning.recentMessages: 20`. Test 3 pins the explicit-value path; the default change is called out here rather than hidden |
| R3 | Chain B fields silently dropped if not passed at `entry.ts` mount | §4.2.1 shows the exact mount call; test 10 asserts the behavior through the entry, not the handler |
| R4 | Cost: each review is a full completion | `minUserTurnsBeforeReview` bounds early firing; `nudgeMode` is host-controlled |
| R5 | `config` optional in `ScopedReviewFlushOptions` | Falls back to `defaultMemoryConfig()` so standalone tests keep working |
| R6 | Windows: fake pi + SQLite handles | Handler-level tests only; no entry-level integration test (see 2026-11-22 lesson). Test 10 uses a minimal fake pi with `on`/`registerTool`, and disposes the handle before removing temp dirs |