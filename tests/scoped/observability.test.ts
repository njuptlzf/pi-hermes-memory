import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createScopedTelemetry,
  instrumentToolRegistration,
  toolResultError,
  type ScopedMetricEvent,
} from "../../src/scoped/observability.js";

/** P2 engineering: bounded, host-neutral metrics for the scoped adapter. */

describe("scoped observability", () => {
  it("computes success rate, P95 and tool failures over a bounded window", () => {
    const collected: ScopedMetricEvent[] = [];
    const telemetry = createScopedTelemetry({
      traceId: "trace-window",
      maxEvents: 10,
      onMetric: (event) => collected.push(event),
    });

    for (let i = 0; i < 10; i++) {
      telemetry.record({
        operation: "tool",
        name: "memory_add",
        startedAt: i,
        durationMs: (i + 1) * 10,
        ok: true,
      });
    }
    telemetry.record({
      operation: "tool",
      name: "memory_add",
      startedAt: 10,
      durationMs: 200,
      ok: false,
      error: "quota exceeded",
    });

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.traceId, "trace-window");
    assert.equal(snapshot.windowSize, 10, "the window must stay bounded");
    assert.equal(collected.length, 11, "the host sink sees every event, even pruned ones");
    assert.equal(snapshot.overall.total, 10);
    assert.equal(snapshot.overall.failed, 1);
    assert.equal(snapshot.overall.successRate, 0.9);
    assert.equal(snapshot.overall.p95DurationMs, 200);
    assert.deepEqual(snapshot.toolFailures, [{ name: "memory_add", count: 1 }]);
    assert.ok(snapshot.events.every((event) => event.traceId === "trace-window"));
  });

  it("aggregates host-reported token usage and cost without guessing prices", () => {
    const telemetry = createScopedTelemetry({ traceId: "t-usage" });
    telemetry.record({
      operation: "completion",
      startedAt: 1,
      durationMs: 12,
      ok: true,
      usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001 },
    });
    telemetry.record({
      operation: "completion",
      startedAt: 2,
      durationMs: 8,
      ok: true,
      usage: { inputTokens: 50, outputTokens: 10, costUsd: 0.0005 },
    });

    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.inputTokens, 150);
    assert.equal(snapshot.outputTokens, 30);
    assert.equal(snapshot.costUsd, 0.0015);
  });

  it("never lets a throwing metric sink break the memory operation", async () => {
    const telemetry = createScopedTelemetry({
      onMetric: () => {
        throw new Error("host sink down");
      },
    });

    const value = await telemetry.measure("erase", undefined, async () => "erased");
    assert.equal(value, "erased");
    assert.equal(telemetry.snapshot().byOperation.erase.successful, 1);
  });

  it("classifies a tool result that reports failure without changing it", async () => {
    const telemetry = createScopedTelemetry();
    const result = await telemetry.measure(
      "tool",
      { name: "memory_add", classify: toolResultError },
      () => ({ details: { success: false, error: "quota" } }),
    );

    assert.deepEqual(result, { details: { success: false, error: "quota" } });
    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.byOperation.tool.total, 1);
    assert.equal(snapshot.byOperation.tool.failed, 1);
    assert.deepEqual(snapshot.toolFailures, [{ name: "memory_add", count: 1 }]);
  });

  it("observes tool registrations through a proxy, without touching tool source files", async () => {
    const definitions: Array<{ name?: string; execute?: (...args: unknown[]) => unknown }> = [];
    const pi = {
      on() {},
      registerTool(definition: { name?: string; execute?: (...args: unknown[]) => unknown }) {
        definitions.push(definition);
        return true;
      },
    };
    const telemetry = createScopedTelemetry({ traceId: "tools" });
    const observed = instrumentToolRegistration(pi, telemetry);

    observed.registerTool({
      name: "memory_add",
      execute: async () => ({ details: { success: true } }),
    });
    const result = (await definitions[0]!.execute!("tc", { target: "memory" })) as {
      details: { success: boolean };
    };

    assert.equal(result.details.success, true);
    assert.equal(telemetry.snapshot().byOperation.tool.successful, 1);
  });
});
