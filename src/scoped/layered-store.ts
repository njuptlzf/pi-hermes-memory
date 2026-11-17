/**
 * A `MemoryStore` facade that routes `target: "user"` to the cross-scope profile
 * store and everything else to the scope store.
 *
 * Why a facade instead of editing the engine: `registerMemoryTool()` decides the
 * store by *raw target* only for `project` (`memory-tool.ts:325`); the rest lands
 * on the single store it was given. Teaching the engine about a second root means
 * touching a file upstream rewrites often, for a concept (tenant layering) the
 * engine does not have. A facade keeps the merge surface at zero and has one
 * property the engine edit does not: an unknown method throws instead of silently
 * reading the wrong directory.
 *
 * The proxy is deliberate. A partial object cast to `MemoryStore` would compile
 * and then fail at runtime the first time an unhandled method is called — but it
 * would fail *somewhere else*, with a confusing message. Here it fails at the
 * boundary and says which method is unrouted.
 */

import type { MemoryStore } from "../store/memory-store.js";

type Target = "memory" | "user" | "failure";

export interface LayeredStoreOptions {
  readonly scopeStore: MemoryStore;
  readonly profileStore: MemoryStore;
}

export function createLayeredStore({ scopeStore, profileStore }: LayeredStoreOptions): MemoryStore {
  const route = (target: Target): MemoryStore => (target === "user" ? profileStore : scopeStore);

  const handlers: Record<string, unknown> = {
    // ── writes: the routing decision ──
    add: (target: Target, content: string, signal?: AbortSignal) => route(target).add(target, content, signal),
    replace: (target: Target, oldText: string, newContent: string, signal?: AbortSignal) =>
      route(target).replace(target, oldText, newContent, signal),
    remove: (target: Target, oldText: string, signal?: AbortSignal) =>
      route(target).remove(target, oldText, signal),
    applyMutationPlan: (
      target: Parameters<MemoryStore["applyMutationPlan"]>[0],
      operations: Parameters<MemoryStore["applyMutationPlan"]>[1],
      options: Parameters<MemoryStore["applyMutationPlan"]>[2],
    ) => route(target).applyMutationPlan(target, operations, options),

    // ── reads: each target has exactly one home ──
    getMemoryEntries: () => scopeStore.getMemoryEntries(),
    getUserEntries: () => profileStore.getUserEntries(),
    getAllFailureEntries: () => scopeStore.getAllFailureEntries(),
    getFailureEntries: (maxAgeDays?: number) => scopeStore.getFailureEntries(maxAgeDays),
    getRawEntriesForSync: (target: Target) => route(target).getRawEntriesForSync(target),
    getStorageIdentity: (target: Target) => route(target).getStorageIdentity(target),
    capacityUsage: (target: Target) => route(target).capacityUsage(target),
    capacityGoal: (target: Target) => route(target).capacityGoal(target),

    // ── lifecycle: both halves, in parallel ──
    loadFromDisk: async () => {
      await Promise.all([scopeStore.loadFromDisk(), profileStore.loadFromDisk()]);
    },
    maintainRecoveryFiles: async () => {
      await Promise.all([scopeStore.maintainRecoveryFiles(), profileStore.maintainRecoveryFiles()]);
    },

    // ── observers and consolidation are scope concerns; the profile is small
    // enough to never need consolidation, and mirroring a consolidator onto it
    // would let one scope's model call rewrite another scope's view of the user ──
    setMutationObserver: (fn: Parameters<MemoryStore["setMutationObserver"]>[0]) => {
      scopeStore.setMutationObserver(fn);
    },
    setConsolidator: (fn: Parameters<MemoryStore["setConsolidator"]>[0]) => {
      scopeStore.setConsolidator(fn);
    },

    // ── rendering: shared first, then scope, each labelled by the caller ──
    formatForSystemPrompt: () =>
      [profileStore.formatForSystemPrompt(), scopeStore.formatForSystemPrompt()].filter(Boolean).join("\n\n"),
    formatProjectBlock: () => "",
  };

  return new Proxy({} as MemoryStore, {
    get(_target, property) {
      if (typeof property !== "string") return undefined;
      const handler = handlers[property];
      if (!handler) {
        throw new Error(
          `LAYERED_STORE_UNROUTED: "${property}" is not routed to either the scope or the profile store — ` +
            "add it to src/scoped/layered-store.ts before the engine starts calling it",
        );
      }
      return handler;
    },
  });
}
