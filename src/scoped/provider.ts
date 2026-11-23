/**
 * Host-neutral memory-provider descriptor for the scoped hermes fork.
 *
 * Shape only — no import from any host SDK, because this module is loaded by a
 * server that must not be a compile-time dependency of the memory engine. The
 * host's own interface (`MemoryProvider`) is satisfied structurally, which is
 * also why a host can swap this module out without touching its build.
 *
 * Entry point for a host that registers providers from configuration:
 *   memoryProviders: ["@njuptlzf/pi-hermes-memory/scoped-provider"]
 *
 * The load-bearing decision here is `selfInjects: false`: upstream hermes
 * appends its policy section in `before_agent_start`, which silently does
 * nothing in a host that does not bind extensions. Handing the text to the host
 * makes the injection explicit instead of accidentally absent.
 */

import { openScopedHermesMemory, type ScopedHermesHandle, type ScopedMemoryTuning } from "./entry.js";
import type { MemoryCompletion } from "./completion-types.js";
import type { CompletionLimits } from "./completion-guard.js";
import {
  createScopedTelemetry,
  type ScopedMetricEvent,
  type ScopedMetricsSnapshot,
} from "./observability.js";

/** Must equal package.json `version`; a test asserts it, so a release cannot drift. */
export const PROVIDER_VERSION = "0.11.0-scoped.6";

export const PROVIDER_ID = "hermes-scoped";

interface ProviderContext {
  /** Absolute, host-computed, one per (user, product, qual). */
  readonly storageRoot: string;
  /**
   * Absolute, host-computed, one per USER. Shared by every scope of that user.
   * Omit it and the tenant is scope-only.
   */
  readonly sharedRoot?: string | null;
  readonly agentDir?: string;
  readonly scope?: { readonly userId: string; readonly productId: string; readonly qual: string };
  /**
   * Host-injected background LLM completion. Optional: when absent, the tenant
   * mounts read/write + search but no auto-consolidation, and the memory write
   * path is unaffected. Structurally matches the host's MemoryCompletion.
   */
  readonly complete?: MemoryCompletion;
  /** Host correlation id propagated to every metric event. Optional. */
  readonly traceId?: string;
  /** Per-event metric sink. Must never throw into the host. Optional. */
  readonly onMetric?: (event: ScopedMetricEvent) => void;
  /** Defensive limits for background completions. Host limits still win. */
  readonly completionLimits?: CompletionLimits;
  /**
   * Policy knobs forwarded to the tenant (review cadence, tool-call trigger,
   * prompt budget). Optional; absent means upstream defaults. Structural shape
   * — the provider still imports no host SDK.
   */
  readonly tuning?: ScopedMemoryTuning;
}

interface ProviderSession {
  readonly providerId: string;
  readonly factory: (pi: unknown) => void;
  readonly selfInjects: boolean;
  readonly traceId: string;
  /** Bounded metrics window; aggregates include success rate, P95 and cost. */
  metrics(): ScopedMetricsSnapshot;
  promptSection(): Promise<string>;
  erase(options?: { readonly includeShared?: boolean }): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * 能力声明（host-neutral 形状，结构化匹配宿主协议，不 import 宿主 SDK）。
 *
 * `sharedProfile: true` = 该实现真的把 `target:"user"` 写进 `<sharedRoot>/profile/USER.md`，
 * 且 `erase()` 默认只删 scope、显式 `erase({includeShared:true})` 才删用户画像
 * （tests/scoped/shared-layer.test.ts + multi-tenant.test.ts 钉住）。宿主据此在
 * "产品声明依赖跨会话画像但选了不支持的 provider"时告警，而不是静默丢失能力。
 */
export interface ScopedHermesProviderCapabilities {
  readonly sharedProfile?: boolean;
}

export interface ScopedHermesProvider {
  readonly id: string;
  readonly version: string;
  /** 能力声明；宿主可读取它做能力不匹配告警。缺省视为不支持。 */
  readonly capabilities?: ScopedHermesProviderCapabilities;
  open(ctx: ProviderContext): Promise<ProviderSession>;
}

const provider: ScopedHermesProvider = {
  id: PROVIDER_ID,
  version: PROVIDER_VERSION,
  capabilities: { sharedProfile: true },
  async open(ctx) {
    // Created before validation so a rejected open is still observable with
    // the host's trace id (or a generated one when the host did not supply it).
    const telemetry = createScopedTelemetry({ traceId: ctx?.traceId, onMetric: ctx?.onMetric });
    return telemetry.measure("open", undefined, async () => {
      if (typeof ctx?.storageRoot !== "string" || ctx.storageRoot.trim() === "") {
        throw new Error("hermes-scoped: open() requires an absolute storageRoot");
      }
      const tenant: ScopedHermesHandle = openScopedHermesMemory({
        storageRoot: ctx.storageRoot,
        sharedRoot: ctx.sharedRoot ?? null,
        complete: ctx.complete,
        telemetry,
        completionLimits: ctx.completionLimits,
        tuning: ctx.tuning,
      });
      return {
        providerId: PROVIDER_ID,
        selfInjects: false,
        traceId: telemetry.traceId,
        metrics: () => tenant.metrics(),
        factory: (pi) => {
          tenant.mount(pi as Parameters<ScopedHermesHandle["mount"]>[0]);
        },
        promptSection: () => tenant.promptSection(),
        erase: (options) => tenant.erase(options),
        dispose: () => tenant.dispose(),
      };
    });
  },
};

export default provider;
