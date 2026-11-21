import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COMPLETION_LIMITS,
  guardCompletion,
} from "../../src/scoped/completion-guard.js";
import type { MemoryCompletionRequest } from "../../src/scoped/completion-types.js";
import { createScopedTelemetry } from "../../src/scoped/observability.js";

/** P2 hardening: defensive timeout, bounded retry and per-tenant serialisation. */

const request: MemoryCompletionRequest = { systemPrompt: "system", userPrompt: "user" };
const ok = (text = "{}") => ({ ok: true, text });

function limits(overrides: Partial<{
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  minIntervalMs: number;
}> = {}) {
  return {
    timeoutMs: 0,
    retries: 0,
    retryDelayMs: 0,
    minIntervalMs: 0,
    ...overrides,
  };
}

describe("scoped completion guard", () => {
  it("ships defensive defaults without changing the host contract", () => {
    assert.equal(DEFAULT_COMPLETION_LIMITS.timeoutMs, 15_000);
    assert.equal(DEFAULT_COMPLETION_LIMITS.retries, 1);
    assert.equal(guardCompletion(undefined), undefined);
  });

  it("passes the host result and usage through to metrics", async () => {
    const telemetry = createScopedTelemetry({ traceId: "guard" });
    let seen: MemoryCompletionRequest | undefined;
    const guarded = guardCompletion(
      async (req) => {
        seen = req;
        return { ok: true, text: "plan", usage: { inputTokens: 10, outputTokens: 4, costUsd: 0.002 } };
      },
      { ...limits(), telemetry },
    )!;

    const result = await guarded(request);
    assert.equal(result.text, "plan");
    assert.ok(seen?.signal);
    const snapshot = telemetry.snapshot();
    assert.equal(snapshot.byOperation.completion.successful, 1);
    assert.equal(snapshot.inputTokens, 10);
    assert.equal(snapshot.outputTokens, 4);
    assert.equal(snapshot.costUsd, 0.002);
  });

  it("retries a transient failure once and records the attempt count", async () => {
    const telemetry = createScopedTelemetry();
    let calls = 0;
    const guarded = guardCompletion(
      async () => {
        calls++;
        return calls === 1
          ? { ok: false, text: "", error: "429 rate limit exceeded" }
          : ok("recovered");
      },
      { ...limits({ retries: 1 }), telemetry },
    )!;

    const result = await guarded(request);
    assert.equal(calls, 2);
    assert.equal(result.ok, true);
    assert.equal(telemetry.snapshot().events[0]!.attempts, 2);
  });

  it("does not retry a non-transient failure", async () => {
    let calls = 0;
    const guarded = guardCompletion(
      async () => {
        calls++;
        return { ok: false, text: "", error: "invalid prompt" };
      },
      { ...limits({ retries: 3 }) },
    )!;

    const result = await guarded(request);
    assert.equal(calls, 1);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /invalid prompt/);
  });

  it("escapes a callback that ignores its AbortSignal", async () => {
    let calls = 0;
    const guarded = guardCompletion(
      () => {
        calls++;
        if (calls === 1) return new Promise<never>(() => {});
        return Promise.resolve(ok("recovered"));
      },
      { ...limits({ timeoutMs: 10, retries: 1 }) },
    )!;

    const result = await guarded(request);
    assert.equal(calls, 2);
    assert.equal(result.text, "recovered");
  });

  it("honours an already-aborted caller signal without calling the host", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const guarded = guardCompletion(
      async () => {
        calls++;
        return ok();
      },
      limits({ retries: 2 }),
    )!;

    const result = await guarded({ ...request, signal: controller.signal });
    assert.equal(calls, 0);
    assert.equal(result.error, "aborted");
  });

  it("serialises completions per tenant", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];

    const guarded = guardCompletion(
      async () => {
        starts.push(Date.now());
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (starts.length === 1) await gate;
        inFlight--;
        return ok();
      },
      limits(),
    )!;

    const first = guarded(request);
    const second = guarded(request);
    release();
    await Promise.all([first, second]);

    assert.equal(maxInFlight, 1);
    assert.equal(starts.length, 2);
  });
});
