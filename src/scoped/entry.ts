/**
 * Scoped (multi-tenant) entry for pi-hermes-memory.
 *
 * What this is: the tenant-safe composition of hermes' memory core — one
 * `MemoryStore` per tenant, the write tool, and the policy prompt. What this is
 * NOT: the full `src/index.ts` surface. The TUI commands, the background review
 * loop and session flush are excluded on purpose, for three reasons that are
 * contract requirements of an in-process host, not preferences:
 *
 *   1. They read `process.env` / `os.homedir()` (host owns configuration).
 *   2. The review loop spawns a `pi` child process (`child_process`), but an
 *      in-process host owns process lifetime.
 *   3. `registerCommand` is a no-op in rpc mode — dead surface that only
 *      misleads.
 *
 * So this file's only inputs are the caller's options. It never looks up a
 * machine-wide default, which is what makes two tenants in one process safe:
 * every path is derived from `options.storageRoot`, and nothing is cached in a
 * module-level mutable.
 *
 * Usage (a host adapter file, three lines, no config discovery):
 *   import { createScopedHermesMemory } from "pi-hermes-memory/scoped";
 *   export default (pi) => createScopedHermesMemory(pi, { storageRoot });
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { defaultMemoryConfig } from "../config.js";
import { buildPromptContext } from "../prompt-context.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import { MemoryStore } from "../store/memory-store.js";
import { registerMemoryTool } from "../tools/memory-tool.js";
import type { MemoryConfig } from "../types.js";
import { resolveScopedRoots, scopedLayout, type ScopedLayout, type ScopedRootInput, type ScopedRoots } from "./roots.js";

export interface ScopedHermesOptions extends ScopedRootInput {
  /** Overrides spread on top of `defaultMemoryConfig()`. Never read from disk. */
  readonly config?: Partial<MemoryConfig>;
  /** Inject the memory policy prompt on `before_agent_start`. Default: true. */
  readonly injectPrompt?: boolean;
}

export interface ScopedHermesHandle {
  readonly roots: ScopedRoots;
  readonly layout: ScopedLayout;
  readonly config: MemoryConfig;
  /** The tenant's store. Exposed so the host can build its own read surfaces. */
  readonly store: MemoryStore;
  /** Resolves once the initial disk load has completed; never rejects unhandled. */
  readonly ready: Promise<void>;
  /** Release the root claim so the same tenant can be re-created. */
  dispose(): Promise<void>;
}

/**
 * One live handle per storage root, per process.
 *
 * Two stores on the same directory would interleave writes with no coordination
 * (upstream's mutation lock is per-process but keyed by file, and both writers
 * would hold it at different times). This is a host-bug guard, not tenant state:
 * the key is the resolved path, never a global "current tenant".
 */
const claimedRoots = new Set<string>();

export function createScopedHermesMemory(options: ScopedHermesOptions): (pi: ExtensionAPI) => ScopedHermesHandle;

/**
 * Immediate-mount form: build the tenant and wire it to `pi` in one call.
 *
 * Both forms exist because hosts differ in *when* they know the tenant. A host
 * that registers factories up front (`extensionFactories: [scopedMemory({dir})]`
 * in agent-chat) needs the curried form; a host that mounts imperatively needs
 * this one. Validation runs in both cases before anything is written, so a
 * wiring mistake fails at startup rather than on the first user message.
 */
export function createScopedHermesMemory(pi: ExtensionAPI, options: ScopedHermesOptions): ScopedHermesHandle;

export function createScopedHermesMemory(
  piOrOptions: ExtensionAPI | ScopedHermesOptions,
  maybeOptions?: ScopedHermesOptions,
): ScopedHermesHandle | ((pi: ExtensionAPI) => ScopedHermesHandle) {
  if (maybeOptions === undefined) {
    const options = piOrOptions as ScopedHermesOptions;
    // Resolve now: a bad root must fail at wiring time, not at first use.
    const roots = resolveScopedRoots(options);
    return (pi: ExtensionAPI) => mountScopedHermesMemory(pi, options, roots);
  }
  return mountScopedHermesMemory(piOrOptions as ExtensionAPI, maybeOptions);
}

function mountScopedHermesMemory(
  pi: ExtensionAPI,
  options: ScopedHermesOptions,
  resolved?: ScopedRoots,
): ScopedHermesHandle {
  const roots = resolved ?? resolveScopedRoots(options);
  const layout = scopedLayout(roots);

  if (claimedRoots.has(layout.memoryDir)) {
    throw new Error(
      `SCOPED_ROOT_IN_USE: ${layout.memoryDir} already has a live scoped-hermes handle in this process`,
    );
  }
  claimedRoots.add(layout.memoryDir);

  const config: MemoryConfig = {
    ...defaultMemoryConfig(),
    ...options.config,
    // The injected root wins over any `memoryDir` in `options.config`: allowing
    // both would let a caller misconfigure one tenant into another's directory.
    memoryDir: layout.memoryDir,
  };

  const store = new MemoryStore(config);
  let disposed = false;

  const ready = store.loadFromDisk().catch((error: unknown) => {
    // Surface the failure to the host without turning it into an unhandled
    // rejection if the host never awaits `ready`.
    queueMicrotask(() => {
      console.error("[scoped-hermes] initial load failed:", error);
    });
  });

  pi.on("session_start", async () => {
    await ready;
  });

  if (options.injectPrompt !== false) {
    pi.on("before_agent_start", async (event) => {
      await ready;
      const promptContext = await buildPromptContext(config, store, null, "", null, false);
      if (!promptContext) return;

      // Same mechanism branch as src/index.ts: 0.86+ re-renders from the option
      // clone (appendSystemPrompt keeps named sections), older runners only
      // honour a returned `systemPrompt`.
      const promptOptions = event.systemPromptOptions;
      if (promptOptions && "sections" in promptOptions) {
        promptOptions.appendSystemPrompt = [promptOptions.appendSystemPrompt, promptContext]
          .filter(Boolean)
          .join("\n\n");
        return;
      }
      return { systemPrompt: event.systemPrompt + "\n\n" + promptContext };
    });
  }

  // No project store in the scoped entry: the tenant root IS the scope, so the
  // per-cwd project layer would re-introduce a shared dimension the host does
  // not want. `()` keeps the tool's project argument inert.
  registerMemoryTool(pi, store, () => null);

  return {
    roots,
    layout,
    config,
    store,
    ready,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await ready;
      // Erasure has to work tenant by tenant: on Windows the directory cannot
      // be removed while the lock database inside it is still open.
      // Path mirrors markdown-mutation-lock.ts:14 — the coordinator sits two
      // levels above the entry file, i.e. directly in the tenant's storage root.
      AtomicLockCoordinator.shared(path.join(roots.storageRoot, ".pi-hermes-locks.sqlite")).closeHandle();
      claimedRoots.delete(layout.memoryDir);
    },
  };
}
