# P2 observability design — scoped hermes provider

> **Status: shipped.** Implemented in commit `441444e`, merged in PR #3
> (`f4407f7`) on 2026-11-21. Windows test portability follow-up in PR #4
> (`e66c60e`). This is an **as-implemented** design record, not a proposal.
> The companion hardening work (`completionLimits`) lives in
> `src/scoped/completion-guard.ts`; this document focuses on trace ids and
> metrics.

## 1. Problem

The scoped adapter is loaded by an in-process host through a structural
`MemoryProvider` port. That port has no logger, metric sink or correlation id.
Before P2 there was no way to answer:

- did `open()` / `erase()` / a tool call succeed, and how long did it take?
- which tool is failing repeatedly?
- how many tokens / how much cost did background completions consume?
- how do all events for one host session correlate?

Any solution had to work without importing the host SDK, without reading
`process.env` or `os.homedir()`, and without spawning a process — all of which
the host owns or forbids.

## 2. Goals and non-goals

**Goals**

1. Accept a host correlation id and a metric sink through the existing
   provider context, with no required host changes.
2. Record a bounded, structured event stream for `open`, tool `execute`,
   `erase` and background `completion`.
3. Expose aggregate metrics: success rate, P95, tool-failure counts and
   host-reported token/cost totals.
4. Make observability strictly best-effort: a broken sink must never break a
   memory operation or change a tool result.

**Non-goals**

- No Prometheus/OTel exporter, no network egress, no file-based logging.
- No price table. Cost is passed through only when the host reports it.
- No memory content in metric events. Only status, duration, error text
  (truncated) and usage are recorded.
- No upstream engine/tool edit. Upstream files stay zero-hunk for clean merges.

## 3. Design principles

| Principle | Decision | Reason |
|---|---|---|
| Host-neutral shape | Provider context gains optional `traceId` / `onMetric` | A host satisfies the shape structurally; no SDK import |
| Boundary instrumentation | Metrics recorded in `provider.ts` / `entry.ts` / a tool Proxy | Upstream tool files remain untouched |
| Bounded memory | 500-event rolling window (`maxEvents`, minimum 10) | Long-lived tenants must not leak event arrays |
| Failure isolation | `onMetric` exceptions swallowed; tool result unchanged | Observability is not a fault path |
| Honest metrics | Cost/usage only from host `usage` | Never guess pricing; absence becomes zero |

## 4. Public surface

`src/scoped/provider.ts` — additive, optional fields only:

```ts
interface ProviderContext {
  readonly storageRoot: string;
  readonly sharedRoot?: string | null;
  readonly agentDir?: string;
  readonly scope?: { userId: string; productId: string; qual: string };
  readonly complete?: MemoryCompletion;
  readonly traceId?: string;                       // new
  readonly onMetric?: (event: ScopedMetricEvent) => void; // new
  readonly completionLimits?: CompletionLimits;   // hardening companion
}

interface ProviderSession {
  readonly providerId: string;
  readonly factory: (pi: unknown) => void;
  readonly selfInjects: boolean;
  readonly traceId: string;                        // new
  metrics(): ScopedMetricsSnapshot;                // new
  promptSection(): Promise<string>;
  erase(options?: { includeShared?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}
```

`openScopedHermesMemory()` also accepts an optional prebuilt `telemetry`, so a
host that calls the scoped entry directly (without the provider descriptor)
gets the same instrumentation. `ScopedHermesHandle` exposes `telemetry` and
`metrics()`.

## 5. Data model

### 5.1 Event

`ScopedMetricEvent` (`src/scoped/observability.ts`):

| Field | Type | Meaning |
|---|---|---|
| `traceId` | `string` | Host-supplied or generated `scoped-<uuid>` |
| `operation` | `"open" \| "erase" \| "tool" \| "completion"` | What was measured |
| `name` | `string?` | Tool name for `tool` events |
| `startedAt` | `number` | `Date.now()` at start |
| `durationMs` | `number` | `performance.now()` delta, monotonic |
| `ok` | `boolean` | Success after classification |
| `error` | `string?` | Error message, truncated to 300 chars |
| `attempts` | `number?` | Completion attempt count after retry |
| `usage` | `ScopedMetricUsage?` | Host-reported `inputTokens` / `outputTokens` / `costUsd` |

### 5.2 Snapshot

`ScopedMetricsSnapshot`:

- `traceId`, `windowSize`
- `overall`: `total`, `successful`, `failed`, `successRate`, `p95DurationMs`
- `byOperation`: same summary keyed by the four operation names
- `toolFailures`: `[{ name, count }]` sorted by count descending
- `inputTokens`, `outputTokens`, `costUsd`
- `events`: copy of the retained window

`successRate` is `0..1` and `0` for an empty window. P95 is the value at
`max(0, ceil(0.95 × n) - 1)` in the sorted duration array. `costUsd` is rounded
to six decimals.

## 6. Trace id lifecycle

1. `provider.open(ctx)` calls `createScopedTelemetry()` **before** validating
   `storageRoot`, so even a rejected open is observable.
2. `traceId = ctx.traceId?.trim() || \`scoped-${randomUUID()}\``.
3. The telemetry object is passed into `openScopedHermesMemory()` and shared by
   all instrumentation points on that tenant.
4. Every emitted event is stamped with the same `traceId`.
5. `session.traceId` and `session.metrics()` let the host correlate the stream.

There is one telemetry instance per tenant handle, not per tool call. Two
handles on different scope roots therefore have different trace ids even in the
same process.

## 7. Instrumentation points

| Point | File | Mechanism |
|---|---|---|
| `open` | `src/scoped/provider.ts` | `telemetry.measure("open", ...)` wraps validation + tenant creation |
| Tool calls | `src/scoped/entry.ts` | `instrumentToolRegistration(pi, telemetry)` returns a Proxy that wraps `registerTool` definitions' `execute` |
| `erase` | `src/scoped/entry.ts` | `telemetry.measure("erase", ...)` wraps the existing erase body |
| Completion | `src/scoped/completion-guard.ts` | records one event per outer completion call, including retries/usage |

The tool Proxy means upstream `src/tools/memory-tool.ts` and
`memory-search-tool.ts` are untouched. It binds non-`registerTool` methods to
the original target, so `pi.on`, `pi.registerCommand`, etc. keep their `this`.

### 7.1 Tool failure classification

`toolResultError()` treats these as failures without throwing:

- `result.isError === true`
- `result.details.success === false`
- `result.details.ok === false`

The original result object is returned unchanged. This matters: a metric must
not turn a handled tool error into an exception.

## 8. Recording and failure isolation

`ScopedTelemetry.measure()`:

1. captures `startedAt` and a monotonic `performance.now()` start;
2. awaits the operation;
3. runs an optional `classify(value)` for non-throwing failures;
4. records in a `finally` block, so thrown errors are also measured;
5. rethrows the original error.

`record()`:

- appends to a bounded array, dropping the oldest events past `maxEvents`;
- truncates error text to 300 characters;
- calls `onMetric` inside `try/catch` and swallows any exception.

No memory entry text, prompt text or credential is included in an event.

## 9. Compatibility and rollout

- All new provider context fields are optional; existing hosts need no change.
- `MemoryCompletionResult` gained optional `usage`; a host returning only
  `{ text, ok }` remains structurally compatible.
- No version bump and no npm publish were part of P2. The fork continues to
  release manually via `scripts/publish-scoped.mjs`.
- A host that wants live streaming passes `onMetric`; a host that only wants
  inspection calls `session.metrics()`.

## 10. Fork boundary and upstream safety

New files are under fork-owned paths:

- `src/scoped/observability.ts`
- `tests/scoped/observability.test.ts`

Modified fork-owned paths:

- `src/scoped/provider.ts`, `entry.ts`, `completion-types.ts`
- `tests/scoped/provider.test.ts`

No upstream engine or tool file was edited. All deltas are registered in
`docs/fork/divergences.json`; `npm run upstream:check:ci` reports
`unregistered 0 / stale 0`.

## 11. Testing

| Test file | Coverage |
|---|---|
| `tests/scoped/observability.test.ts` | bounded window, success rate/P95, token+cost aggregation, throwing sink, tool Proxy classification |
| `tests/scoped/completion-guard.test.ts` | defaults, usage passthrough, transient retry, no retry, stuck callback, abort, serialisation |
| `tests/scoped/provider.test.ts` | trace id propagation and `open` / tool / `erase` events on the real provider descriptor |

New tests: 12. Scoped suite: 68/68. Full CI: five checks green, including the
Linux test job and the fork-delta gate.

## 12. Decision log

| Question | Decision | Alternative rejected |
|---|---|---|
| How does the host receive metrics? | Optional `onMetric` callback + `metrics()` | Import host logger/SDK — breaks host neutrality |
| How to instrument tools? | Proxy `registerTool` at the entry boundary | Edit upstream tool files — increases merge surface |
| How much history to keep? | 500-event bounded window | Unbounded array — leaks in long-lived tenants |
| Where does cost come from? | Host-reported `usage.costUsd` only | Hard-coded price table — wrong across models/providers |
| What if the sink throws? | Swallow | Propagate — observability becomes a fault path |

## 13. Future work

- Prometheus / OTel exporter as a separate host-side adapter, not in this repo.
- Extend the host `MemoryProvider` protocol with an official `observability`
  capability flag if more hosts start consuming `onMetric`.
- Add a `/memory-metrics` command only if a direct Pi (non-host) use case appears;
  today no TUI command is mounted in the scoped adapter by design.
- Revisit `maxEvents` / P95 strategy if an eval shows the 500-event window is
  too small for production diagnosis.

## 14. Reference

- Implementation: `src/scoped/observability.ts`
- Wiring: `src/scoped/provider.ts`, `src/scoped/entry.ts`
- Hardening companion: `src/scoped/completion-guard.ts`
- Task status: `docs/fork/TASKS.md` → P2 — engineering
