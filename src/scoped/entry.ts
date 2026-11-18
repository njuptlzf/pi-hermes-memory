/**
 * Scoped (multi-tenant) entry for pi-hermes-memory.
 *
 * What this is: the tenant-safe composition of hermes' memory core — one
 * `MemoryStore` per scope, a cross-scope profile store per user, one SQLite
 * FTS5 mirror per scope, the write tool, the `memory_search` read tool, and a
 * policy prompt built from what is actually mounted. What this is NOT: the full
 * `src/index.ts` surface. TUI commands, the background review loop, session
 * flush and session search are excluded on purpose, for three reasons that are
 * contract requirements of an in-process host, not preferences:
 *
 *   1. They read `process.env` / `os.homedir()` (host owns configuration).
 *   2. The review loop spawns a `pi` child process, but an in-process host owns
 *      process lifetime.
 *   3. `registerCommand` is a no-op in rpc mode — dead surface that only misleads.
 *
 * The search mirror is deliberately per-scope and lives under `memoryDir`: the
 * host's `runtimeRoot` is shared across tenants and must never hold a tenant's
 * memory index, and SQLite files are the one resource that outlives a `close()`
 * on Windows unless released explicitly (see dispose/erase).
 *
 * Two halves, split on purpose: `openScopedHermesMemory()` builds the tenant
 * (stores, prompt text, erasure) and needs no pi; `handle.mount(pi)` attaches
 * tools and hooks. A host that assembles its own system prompt can therefore ask
 * for the memory section before pi binds anything, which is the order
 * `createAgentSession` actually uses.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { defaultMemoryConfig } from "../config.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import { DatabaseManager } from "../store/db.js";
import { MemoryStore } from "../store/memory-store.js";
import {
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
} from "../store/sqlite-memory-store.js";
import { registerMemorySearchTool } from "../tools/memory-search-tool.js";
import { registerMemoryTool } from "../tools/memory-tool.js";
import type { MemoryConfig } from "../types.js";
import { createLayeredStore } from "./layered-store.js";
import { buildScopedMemoryPolicy } from "./policy.js";
import { resolveScopedRoots, scopedLayout, type ScopedLayout, type ScopedRootInput, type ScopedRoots } from "./roots.js";

export interface ScopedHermesOptions extends ScopedRootInput {
  /** Overrides spread on top of `defaultMemoryConfig()`. Never read from disk. */
  readonly config?: Partial<MemoryConfig>;
  /** Inject the memory policy prompt on `before_agent_start`. Default: true. */
  readonly injectPrompt?: boolean;
  /** Max characters of shared profile injected into the prompt. Default: 1200. */
  readonly profilePromptChars?: number;
}

export interface EraseOptions {
  /**
   * Also erase the cross-scope profile (`sharedRoot`).
   *
   * Off by default on purpose: erasing one qualification must not delete the
   * user's identity. Account deletion is the caller's explicit second call.
   */
  readonly includeShared?: boolean;
}

export interface ScopedHermesHandle {
  readonly roots: ScopedRoots;
  readonly layout: ScopedLayout;
  readonly config: MemoryConfig;
  /**
   * The store the tool writes through: `target: "user"` goes to the profile,
   * everything else to the scope. Exposed for hosts that build their own reads.
   */
  readonly store: MemoryStore;
  /** The cross-scope profile store, or null in a scope-only tenant. */
  readonly profileStore: MemoryStore | null;
  /** Resolves once the initial disk load has completed; never rejects unhandled. */
  readonly ready: Promise<void>;
  /** The memory policy section, for a host that assembles the prompt itself. */
  promptSection(): Promise<string>;
  /** Attach tools and hooks to a pi instance. Safe to call once per handle. */
  mount(pi: ExtensionAPI): void;
  /** Erase this scope; optionally the user's shared profile too. */
  erase(options?: EraseOptions): Promise<void>;
  /** Release the root claim and pinned connections. */
  dispose(): Promise<void>;
}

/**
 * One live handle per scope root, per process.
 *
 * Two stores on the same directory would interleave writes with no coordination.
 * The shared profile root is deliberately NOT claimed: several scopes of the same
 * user are supposed to open it at once.
 */
const claimedRoots = new Set<string>();

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

  const scopeStore = new MemoryStore(config);
  const profileStore = layout.profileDir === null
    ? null
    : new MemoryStore({ ...config, memoryDir: layout.profileDir });
  const store = profileStore === null
    ? scopeStore
    : createLayeredStore({ scopeStore, profileStore });

  // The FTS5 search mirror is a per-tenant SQLite file living next to this
  // scope's Markdown. It is NOT shared with other scopes of the same user:
  // sharing it would let one scope's reindex rewrite another's search results
  // and would make erasure ambiguous. Markdown stays the source of truth —
  // every mirror row can be rebuilt by reconciling from disk.
  const dbManager = new DatabaseManager(layout.memoryDir);
  const dbLockPath = path.join(layout.memoryDir, ".pi-hermes-locks.sqlite");

  let disposed = false;
  let mounted = false;

  // Seed the mirror from Markdown on every open. New tenants start empty and
  // cost two indexed reads; tenants created by an earlier version get their
  // pre-existing entries indexed. The reconcile functions fingerprint the
  // entries, so an unchanged reopen is a no-op rather than a rewrite.
  const seedSearchMirror = (): void => {
    try {
      reconcileMarkdownMemoryScope(dbManager, scopeStore.getRawEntriesForSync("memory"), "memory", null);
      reconcileMarkdownFailureScopes(dbManager, scopeStore.getRawEntriesForSync("failure"));
      if (profileStore !== null) {
        reconcileMarkdownMemoryScope(dbManager, profileStore.getRawEntriesForSync("user"), "user", null);
      }
    } catch (error: unknown) {
      // A search index is best-effort: Markdown writes must never fail because
      // a stale/corrupt mirror could not be seeded. DatabaseManager quarantines
      // and rebuilds a corrupt file on the next access, so this is recoverable.
      queueMicrotask(() => {
        console.error("[scoped-hermes] search mirror seed failed:", error);
      });
    }
  };

  // `registerMemoryTool` wires its reconcile observer through the layered
  // store, which forwards `setMutationObserver` to the SCOPE store only. The
  // shared profile has no observer, so without this its writes would be
  // searchable on the next open (via seed) but not in the current session.
  if (profileStore !== null) {
    profileStore.setMutationObserver((_target, entries) => {
      reconcileMarkdownMemoryScope(dbManager, entries, "user", null);
      return Promise.resolve(undefined);
    });
  }

  const ready = Promise.all([scopeStore.loadFromDisk(), profileStore?.loadFromDisk() ?? Promise.resolve()])
    .then(() => {
      seedSearchMirror();
    })
    .catch((error: unknown) => {
      // Surface the failure without turning it into an unhandled rejection when
      // the host never awaits `ready`.
      queueMicrotask(() => {
        console.error("[scoped-hermes] initial load failed:", error);
      });
    });

  const profileSection = (): string => {
    if (profileStore === null) return "";
    const limit = options.profilePromptChars ?? 1200;
    const entries = profileStore.getUserEntries();
    if (entries.length === 0) return "";

    // Capped and counted: a silently truncated profile looks complete to the
    // model, and it will answer as if the tail does not exist.
    const shown: string[] = [];
    let used = 0;
    for (const entry of entries) {
      if (used + entry.length > limit) break;
      shown.push(entry);
      used += entry.length;
    }
    const hidden = entries.length - shown.length;
    const more = hidden > 0 ? `\n- (${hidden} more profile entries not shown)` : "";
    return `<user-profile scope="shared-across-scopes">\n${shown.map((entry) => `- ${entry}`).join("\n")}${more}\n</user-profile>`;
  };

  const promptSection = async (): Promise<string> => {
    await ready;
    const policy = buildScopedMemoryPolicy({
      // A flag may only be true when the matching tool is actually mounted in
      // mount() below — a prompt that promises an absent tool wastes model turns.
      hasSearch: true,
      hasSessionSearch: false,
      hasSkills: false,
      hasProjectStore: false,
      hasSharedProfile: profileStore !== null,
    });
    return [policy, profileSection()].filter(Boolean).join("\n\n");
  };

  const releaseLock = (root: string): void => {
    // Path mirrors markdown-mutation-lock.ts:14 — the coordinator sits two levels
    // above the entry file, i.e. directly in the root that holds `memory/`.
    AtomicLockCoordinator.shared(path.join(root, ".pi-hermes-locks.sqlite")).closeHandle();
  };

  return {
    roots,
    layout,
    config,
    store,
    profileStore,
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
      // does not want. `()` keeps the tool's project argument inert. Passing the
      // dbManager is what mirrors writes into this tenant's FTS5 index; without
      // it the search tool is mounted but would never see new memories.
      registerMemoryTool(pi, store, () => null, dbManager);
      registerMemorySearchTool(pi, dbManager, { usageTrackingEnabled: config.usageHitTrackingEnabled });
    },
    async erase(eraseOptions?: EraseOptions) {
      await ready;
      // Close pinned connections first: Windows refuses to unlink an open file.
      // Both the markdown-mutation lock and the SQLite handle/lock live under
      // storageRoot, so all three must be released before the recursive rm.
      dbManager.close();
      AtomicLockCoordinator.shared(dbLockPath).closeHandle();
      releaseLock(roots.storageRoot);
      await fs.rm(roots.storageRoot, { recursive: true, force: true });
      claimedRoots.delete(layout.memoryDir);

      if (eraseOptions?.includeShared && roots.sharedRoot !== null) {
        releaseLock(roots.sharedRoot);
        await fs.rm(roots.sharedRoot, { recursive: true, force: true });
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await ready;
      dbManager.close();
      AtomicLockCoordinator.shared(dbLockPath).closeHandle();
      releaseLock(roots.storageRoot);
      if (roots.sharedRoot !== null) releaseLock(roots.sharedRoot);
      claimedRoots.delete(layout.memoryDir);
    },
  };
}

export function createScopedHermesMemory(options: ScopedHermesOptions): (pi: ExtensionAPI) => ScopedHermesHandle;

/**
 * Immediate-mount form: build the tenant and wire it to `pi` in one call.
 *
 * Both forms exist because hosts differ in *when* they know the tenant. A host
 * that registers factories up front needs the curried form; a host that mounts
 * imperatively needs this one. Validation runs in both cases before anything is
 * written, so a wiring mistake fails at startup rather than on the first message.
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
  const handle = openWithRoots(maybeOptions, resolveScopedRoots(maybeOptions));
  handle.mount(piOrOptions as ExtensionAPI);
  return handle;
}
