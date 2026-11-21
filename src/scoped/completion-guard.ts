/**
 * Provider-side hardening for the host-injected background completion.
 *
 * The host still owns the real model timeout and token budget. These limits are
 * defensive: they protect a scoped provider that is mounted by a host which
 * forgets to bound its callback, serialises concurrent background work, and
 * retries only transient failures. No spawn, no env, no credentials.
 */

import { performance } from "node:perf_hooks";
import type {
  MemoryCompletion,
  MemoryCompletionRequest,
  MemoryCompletionResult,
  MemoryCompletionUsage,
} from "./completion-types.js";
import type { MeasureOptions, ScopedMetricUsage, ScopedTelemetry } from "./observability.js";

export interface CompletionLimits {
  /** Hard wall-clock budget per attempt. 0 disables. Default 15000 ms. */
  readonly timeoutMs?: number;
  /** Retries on transient errors only. Default 1; clamped to 0..5. */
  readonly retries?: number;
  /** Linear backoff between retries. Default 200 ms. */
  readonly retryDelayMs?: number;
  /** Minimum gap between the start of two completions. Default 250 ms. */
  readonly minIntervalMs?: number;
}

export interface GuardCompletionOptions extends CompletionLimits {
  readonly telemetry?: ScopedTelemetry;
}

export const DEFAULT_COMPLETION_LIMITS = {
  timeoutMs: 15_000,
  retries: 1,
  retryDelayMs: 200,
  minIntervalMs: 250,
} as const;

const TRANSIENT_ERROR =
  /timeout|timed out|rate.?limit|429|50[234]|temporar|econnreset|socket hang up|network/i;

class CompletionTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompletionTimeoutError";
  }
}

function isTransient(error: unknown): boolean {
  if (error instanceof CompletionTimeoutError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_ERROR.test(message);
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new Error("aborted");
}

function abortedResult(): MemoryCompletionResult {
  return { ok: false, text: "", error: "aborted" };
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Race the host callback against a local timeout. A callback that ignores its
 * AbortSignal cannot hang the scoped provider: the timeout promise rejects the
 * race even when the underlying promise never settles.
 */
async function withTimeout(
  complete: MemoryCompletion,
  request: MemoryCompletionRequest,
  timeoutMs: number,
): Promise<MemoryCompletionResult> {
  if (request.signal?.aborted) throw abortReason(request.signal);

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  let cleanupRejectAbort: () => void = () => {};

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    const onRejectAbort = (): void => {
      controller.abort(abortReason(request.signal));
      reject(abortReason(request.signal));
    };
    request.signal?.addEventListener("abort", onRejectAbort, { once: true });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const error = new CompletionTimeoutError(`completion timeout after ${timeoutMs}ms`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    }
    cleanupRejectAbort = () => request.signal?.removeEventListener("abort", onRejectAbort);
  });

  try {
    return await Promise.race([
      complete({ ...request, signal: controller.signal }),
      timeoutPromise,
    ]);
  } finally {
    cleanupRejectAbort();
    if (timer !== undefined) clearTimeout(timer);
  }
}

function metricUsage(usage: MemoryCompletionUsage | undefined): ScopedMetricUsage | undefined {
  if (usage === undefined) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  };
}

/**
 * Wrap a host completion with timeout, bounded retry and per-tenant rate limiting.
 *
 * Returns undefined unchanged when the host did not inject a completion, so the
 * caller can keep using "capability present?" checks without a second flag.
 */
export function guardCompletion(
  complete: MemoryCompletion | undefined,
  options: GuardCompletionOptions = {},
): MemoryCompletion | undefined {
  if (complete === undefined) return undefined;

  const timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_COMPLETION_LIMITS.timeoutMs);
  const retries = Math.max(
    0,
    Math.min(5, Math.floor(options.retries ?? DEFAULT_COMPLETION_LIMITS.retries)),
  );
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_COMPLETION_LIMITS.retryDelayMs);
  const minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_COMPLETION_LIMITS.minIntervalMs);
  const telemetry = options.telemetry;

  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt = 0;

  return (request: MemoryCompletionRequest): Promise<MemoryCompletionResult> => {
    const startedAt = Date.now();
    const started = performance.now();
    const measureOptions: MeasureOptions = { attempts: 0 };
    let usage: MemoryCompletionUsage | undefined;
    let finalOk = false;
    let finalError: string | undefined;

    const run = async (): Promise<MemoryCompletionResult> => {
      const wait = Math.max(0, lastStartedAt + minIntervalMs - Date.now());
      if (wait > 0) {
        try {
          await delay(wait, request.signal);
        } catch {
          return abortedResult();
        }
      }
      if (request.signal?.aborted) return abortedResult();
      lastStartedAt = Date.now();

      for (let attempt = 0; attempt <= retries; attempt++) {
        if (request.signal?.aborted) return abortedResult();
        measureOptions.attempts = attempt + 1;

        if (attempt > 0) {
          try {
            await delay(retryDelayMs * attempt, request.signal);
          } catch {
            return abortedResult();
          }
        }

        try {
          const result = await withTimeout(complete, request, timeoutMs);
          usage = result.usage;
          measureOptions.usage = metricUsage(usage);
          if (result.ok) return result;

          finalError = result.error ?? "completion failed";
          if (attempt === retries || request.signal?.aborted || !isTransient(finalError)) {
            return { ...result, error: finalError };
          }
        } catch (error) {
          if (request.signal?.aborted) return abortedResult();
          finalError = error instanceof Error ? error.message : String(error);
          if (attempt === retries || !isTransient(error)) {
            return {
              ok: false,
              text: "",
              error: finalError,
              ...(usage === undefined ? {} : { usage }),
            };
          }
        }
      }

      return {
        ok: false,
        text: "",
        error: finalError ?? "completion failed",
        ...(usage === undefined ? {} : { usage }),
      };
    };

    // Serialise all completions on this tenant: the guard is created once per
    // handle, so consolidation/review/flush cannot race each other here.
    const queued = tail.then(run, run);
    tail = queued.then(
      () => undefined,
      () => undefined,
    );

    return queued
      .then((result) => {
        finalOk = result.ok;
        if (!result.ok) finalError = result.error ?? finalError;
        return result;
      })
      .finally(() => {
        telemetry?.record({
          operation: "completion",
          startedAt,
          durationMs: performance.now() - started,
          ok: finalOk,
          error: finalOk ? undefined : finalError,
          attempts: measureOptions.attempts,
          usage: measureOptions.usage,
        });
      });
  };
}
