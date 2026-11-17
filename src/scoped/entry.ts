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
 * Two halves, split on purpose: `openScopedHermesMemory()` builds the tenant
 * (store, prompt text, erasure) and needs no pi; `handle.mount(pi)` attaches
 * tools and hooks. A host that assembles its own system prompt can therefore
 * ask for the memory section before pi binds anything, which is the order
 * `createAgentSession` actually uses.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
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
  /**
   * The memory policy section, for a host that assembles the system prompt
   * itself instead of letting the extension append to it.
   *
   * Both routes exist because hosts differ: pi appends via a `before_agent_start`
   * hook, a server that owns prompt composition would rather take the text and
   * decide where it lands. Same source, so the two can never drift.
   */
  promptSection(): Promise<string>;
  /** Attach tools and hooks to a pi instance. Safe to call once per handle. */
  mount(pi: ExtensionAPI): void;
  /**
   * Delete everything this tenant stored, and release its handles.
   *
   * The erasure promise the whole fork exists for: one call, one tenant gone,
   * no other tenant disturbed. Refuses to touch anything outside the root.
   */
  erase(): Promise<void>;
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

/**
 * Build a tenant without touching pi.
 *
 * A host that owns prompt assembly needs `promptSection()` before the session
 * exists; requiring pi first would force it to mount an extension it only
 * wants a string from.
 */
export function openScopedHermesMemory(options: ScopedHermesOptions): ScopedHermesHandle {
  return openWithRoots(options, resolveScopedRoots(options));
}

function openWithRoots(options: ScopedHermesOptions, roots: ScopedRoots): ScopedHermesHandle {
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
  let mounted = false;

  const ready = store.loadFromDisk().catch((error: unknown) => {
    // Surface the failure to the host without turning it into an unhandled
    // rejection if the host never awaits `ready`.
    queueMicrotask(() => {
      console.error("[scoped-hermes] initial load failed:", error);
    });
  });

  const promptSection = async (): Promise<string> => {
    await ready;
    return buildPromptContext(config, store, null, "", null, false);
  };

  const releaseLock = (): void => {
    // Path mirrors markdown-mutation-lock.ts:14 — the coordinator sits two levels
    // above the entry file, i.e. directly in the tenant's storage root.
    AtomicLockCoordinator.shared(path.join(roots.storageRoot, ".pi-hermes-locks.sqlite")).closeHandle();
  };

  return {
    roots,
    layout,
    config,
    store,
    ready,
    promptSection,
    mount(pi: ExtensionAPI) {
      if (mounted) {
        throw new Error("SCOPED_HANDLE_ALREADY_MOUNTED: one pi instance per tenant handle");
      }
      mounted = true;

      pi.on("session_start", async () => {
        await ready;
      });

      if (options.injectPrompt !== false) {
        pi.on("before_agent_start", async (event) => {
          const section = await promptSection();
          if (!section) return;

          // Same mechanism branch as src/index.ts: 0.86+ re-renders from the
          // option clone (appendSystemPrompt keeps named sections), older
          // runners only honour a returned `systemPrompt`.
          const promptOptions = event.systemPromptOptions;
          if (promptOptions && "sections" in promptOptions) {
            promptOptions.appendSystemPrompt = [promptOptions.appendSystemPrompt, section]
              .filter(Boolean)
              .join("\n\n");
            return;
          }
          return { systemPrompt: event.systemPrompt + "\n\n" + section };
        });
      }

      // No project store in the scoped entry: the tenant root IS the scope, so
      // the per-cwd project layer would re-introduce a shared dimension the host
      // does not want. `()` keeps the tool's project argument inert.
      registerMemoryTool(pi, store, () => null);
    },
    async erase() {
      await ready;
      // Erasure is the contract: close the pinned connection first (Windows
      // refuses to unlink an open file), then remove exactly this tenant.
      releaseLock();
      await fs.rm(roots.storageRoot, { recursive: true, force: true });
      claimedRoots.delete(layout.memoryDir);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await ready;
      releaseLock();
      claimedRoots.delete(layout.memoryDir);
    },
  };
}

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
    // Validate at factory creation, not at mount: a host that wires a bad root
    // should fail while it is wiring, not on the first user message.
    const roots = resolveScopedRoots(options);
    return (pi: ExtensionAPI) => {
      const handle = openWithRoots(options, roots);
      handle.mount(pi);
      return handle;
    };
  }
  const handle = openScopedHermesMemory(maybeOptions);
  handle.mount(piOrOptions as ExtensionAPI);
  return handle;
}
