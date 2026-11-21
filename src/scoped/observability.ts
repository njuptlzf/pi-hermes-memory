/**
 * Fork-owned observability for the scoped (multi-tenant) adapter.
 *
 * The host port has no logger, metrics sink or correlation id. This module
 * supplies a host-neutral one: the provider accepts an optional `traceId` and
 * `onMetric` callback, records a bounded window of operation events, and
 * exposes a snapshot. Observability is strictly best-effort — a throwing metric
 * sink must never break a memory read, write or erase.
 *
 * No env, no homedir, no network: the host owns all of those.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type ScopedOperation = "open" | "erase" | "tool" | "completion";

export interface ScopedMetricUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  /** Host-reported cost in USD. The provider never guesses a price table. */
  readonly costUsd?: number;
}

export interface ScopedMetricEvent {
  readonly traceId: string;
  readonly operation: ScopedOperation;
  /** Tool name for `tool` events; absent for other operations. */
  readonly name?: string;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly error?: string;
  /** Number of completion attempts, for retried `completion` events. */
  readonly attempts?: number;
  readonly usage?: ScopedMetricUsage;
}

export interface ScopedMetricSummary {
  readonly total: number;
  readonly successful: number;
  readonly failed: number;
  /** 0..1; 0 when no events have been recorded. */
  readonly successRate: number;
  readonly p95DurationMs: number;
}

export interface ScopedMetricsSnapshot {
  readonly traceId: string;
  /** Number of retained events (bounded by `maxEvents`). */
  readonly windowSize: number;
  readonly overall: ScopedMetricSummary;
  readonly byOperation: Record<ScopedOperation, ScopedMetricSummary>;
  readonly toolFailures: ReadonlyArray<{ readonly name: string; readonly count: number }>;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly events: readonly ScopedMetricEvent[];
}

export interface ScopedTelemetryOptions {
  /** Host correlation id. A fresh one is generated when omitted or blank. */
  readonly traceId?: string;
  /** Per-event sink. Exceptions are swallowed by design. */
  readonly onMetric?: (event: ScopedMetricEvent) => void;
  /** Retained event window. Default 500; minimum 10. */
  readonly maxEvents?: number;
}

export interface MeasureOptions {
  name?: string;
  usage?: ScopedMetricUsage;
  attempts?: number;
  /** Classify a non-throwing result as a failure, e.g. a tool result with success:false. */
  classify?: (value: unknown) => string | undefined;
}

export interface ScopedTelemetry {
  readonly traceId: string;
  record(event: Omit<ScopedMetricEvent, "traceId">): void;
  measure<T>(
    operation: ScopedOperation,
    options: MeasureOptions | undefined,
    fn: () => Promise<T> | T,
  ): Promise<T>;
  snapshot(): ScopedMetricsSnapshot;
}

const OPERATIONS: readonly ScopedOperation[] = ["open", "erase", "tool", "completion"];

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function summarize(events: readonly ScopedMetricEvent[]): ScopedMetricSummary {
  const durations = events.map((event) => event.durationMs).sort((a, b) => a - b);
  const failed = events.reduce((count, event) => count + (event.ok ? 0 : 1), 0);
  const total = events.length;
  const p95Index = total === 0 ? -1 : Math.max(0, Math.ceil(total * 0.95) - 1);
  return {
    total,
    successful: total - failed,
    failed,
    successRate: total === 0 ? 0 : (total - failed) / total,
    p95DurationMs: p95Index < 0 ? 0 : Math.round(durations[p95Index]! * 100) / 100,
  };
}

function numberOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Recognise the common "tool ran but reported failure" shapes without importing
 * a host SDK. `memory_add` uses `details.success`; other tools may use
 * `details.ok` or `isError`.
 */
export function toolResultError(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const result = value as { details?: unknown; isError?: unknown };
  if (result.isError === true) return "tool reported error";
  if (result.details === null || typeof result.details !== "object") return undefined;
  const details = result.details as { success?: unknown; ok?: unknown; error?: unknown };
  if (details.success !== false && details.ok !== false) return undefined;
  return typeof details.error === "string" && details.error ? details.error : "tool reported failure";
}

/** Wrap `pi.registerTool` so every execute() pass through the metric recorder. */
export function instrumentToolRegistration<TPi extends object>(pi: TPi, telemetry: ScopedTelemetry): TPi {
  return new Proxy(pi, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === "registerTool" && typeof value === "function") {
        return (definition: unknown) =>
          Reflect.apply(value, target, [wrapToolDefinition(definition, telemetry)]);
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrapToolDefinition(definition: unknown, telemetry: ScopedTelemetry): unknown {
  if (definition === null || typeof definition !== "object") return definition;
  const tool = definition as Record<string, unknown>;
  const execute = tool.execute;
  if (typeof execute !== "function") return definition;
  const name = typeof tool.name === "string" && tool.name ? tool.name : "unknown";
  return {
    ...tool,
    execute: (...args: unknown[]) =>
      telemetry.measure(
        "tool",
        { name, classify: toolResultError },
        () => Reflect.apply(execute, tool, args),
      ),
  };
}

export function createScopedTelemetry(options: ScopedTelemetryOptions = {}): ScopedTelemetry {
  const traceId = options.traceId?.trim() || `scoped-${randomUUID()}`;
  const maxEvents = Math.max(10, Math.floor(options.maxEvents ?? 500));
  const onMetric = options.onMetric;
  const events: ScopedMetricEvent[] = [];

  const record: ScopedTelemetry["record"] = (event) => {
    const clean: ScopedMetricEvent = {
      ...event,
      traceId,
      error: event.error ? errorText(event.error) : undefined,
    };
    events.push(clean);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    // A sink owned by the host must never become a fault path for memory ops.
    try {
      onMetric?.(clean);
    } catch {
      // Intentionally swallowed.
    }
  };

  return {
    traceId,
    record,
    async measure<T>(
      operation: ScopedOperation,
      measureOptions: MeasureOptions | undefined,
      fn: () => Promise<T> | T,
    ): Promise<T> {
      const startedAt = Date.now();
      const started = performance.now();
      let ok = false;
      let error: string | undefined;
      try {
        const value = await fn();
        error = measureOptions?.classify?.(value);
        ok = error === undefined;
        return value;
      } catch (err) {
        error = errorText(err);
        throw err;
      } finally {
        record({
          operation,
          name: measureOptions?.name,
          usage: measureOptions?.usage,
          attempts: measureOptions?.attempts,
          startedAt,
          durationMs: performance.now() - started,
          ok,
          error,
        });
      }
    },
    snapshot(): ScopedMetricsSnapshot {
      const toolFailures = new Map<string, number>();
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;
      for (const event of events) {
        if (event.operation === "tool" && !event.ok) {
          const name = event.name ?? "unknown";
          toolFailures.set(name, (toolFailures.get(name) ?? 0) + 1);
        }
        inputTokens += numberOrZero(event.usage?.inputTokens);
        outputTokens += numberOrZero(event.usage?.outputTokens);
        costUsd += numberOrZero(event.usage?.costUsd);
      }
      const byOperation = {} as Record<ScopedOperation, ScopedMetricSummary>;
      for (const operation of OPERATIONS) {
        byOperation[operation] = summarize(events.filter((event) => event.operation === operation));
      }
      return {
        traceId,
        windowSize: events.length,
        overall: summarize(events),
        byOperation,
        toolFailures: [...toolFailures.entries()]
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count),
        inputTokens,
        outputTokens,
        costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
        events: events.slice(),
      };
    },
  };
}
