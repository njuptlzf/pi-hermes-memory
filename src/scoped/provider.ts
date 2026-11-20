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

import { openScopedHermesMemory, type ScopedHermesHandle } from "./entry.js";
import type { MemoryCompletion } from "./completion-types.js";

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
}

interface ProviderSession {
  readonly providerId: string;
  readonly factory: (pi: unknown) => void;
  readonly selfInjects: boolean;
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
    if (typeof ctx?.storageRoot !== "string" || ctx.storageRoot.trim() === "") {
      throw new Error("hermes-scoped: open() requires an absolute storageRoot");
    }
    const tenant: ScopedHermesHandle = openScopedHermesMemory({
      storageRoot: ctx.storageRoot,
      sharedRoot: ctx.sharedRoot ?? null,
      complete: ctx.complete,
    });
    return {
      providerId: PROVIDER_ID,
      selfInjects: false,
      factory: (pi) => {
        tenant.mount(pi as Parameters<ScopedHermesHandle["mount"]>[0]);
      },
      promptSection: () => tenant.promptSection(),
      erase: (options) => tenant.erase(options),
      dispose: () => tenant.dispose(),
    };
  },
};

export default provider;
