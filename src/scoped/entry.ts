/**
 * Scoped (multi-tenant) entry for pi-hermes-memory.
 *
 * What this is: the tenant-safe composition of hermes' memory core — one
 * `MemoryStore` per scope, a cross-scope profile store per user, one SQLite
 * FTS5 mirror per scope, the write tool, the `memory_search` read tool, a
 * policy prompt built from what is actually mounted, verbatim current-session
 * recall (`session_search` + live turn indexing, `src/scoped/session-search.ts`),
 * and — when the host
 * injects `complete` — correction detection (`src/scoped/correction.ts`) plus
 * background review and session flush (`src/scoped/review-flush.ts`), all three
 * sharing one background gate so their writes never overlap. What this is NOT: the full `src/index.ts`
 * surface. TUI commands are excluded on purpose (inert under rpc), and
 * session search is the current-session slice
 * (`src/scoped/session-search.ts`), not upstream's file-scanning variant —
 * the full entry's env-reading / child-process machinery is replaced by injected
 * parameters, for three reasons that are contract requirements of an
 * in-process host, not preferences:
 *
 *   1. The full entry reads `process.env` / `os.homedir()` (host owns configuration).
 *   2. Its background work spawns a `pi` child process, but an in-process host
 *      owns process lifetime; review/flush here use the injected completion
 *      callback instead (see review-flush.ts).
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
import { consolidateViaCompletion } from "./consolidation.js";
import { setupScopedReviewFlush, type NudgeMode } from "./review-flush.js";
import { setupScopedCorrectionDetector } from "./correction.js";
import { attachScopedSessionIndex, mountScopedSessionSearch, startScopedHistoryBackfill } from "./session-search.js";
import { runScopedSessionRetention } from "./session-retention.js";
import { createBackgroundGate } from "./background-gate.js";
import type { MemoryCompletion } from "./completion-types.js";
import type { MemoryHistoryPort } from "./history-types.js";
import { AtomicLockCoordinator } from "../store/atomic-lock-coordinator.js";
import { DatabaseManager, DATABASE_CLOSED_MESSAGE } from "../store/db.js";
import { MemoryStore } from "../store/memory-store.js";
import { StandingInstructions } from "../store/standing-instructions.js";
import {
  reconcileMarkdownFailureScopes,
  reconcileMarkdownMemoryScope,
} from "../store/sqlite-memory-store.js";
import { registerMemorySearchTool } from "../tools/memory-search-tool.js";
import { registerMemoryTool } from "../tools/memory-tool.js";
import { attachRetrieval, type RetrievalBudget } from "./retrieval.js";
import type { MemoryConfig } from "../types.js";
import { createLayeredStore } from "./layered-store.js";
import { replaceOwnedBlocks } from "./prompt-blocks.js";
import { buildScopedMemoryPolicy } from "./policy.js";
import { resolveScopedRoots, scopedLayout, type ScopedLayout, type ScopedRootInput, type ScopedRoots } from "./roots.js";
import { guardCompletion, type CompletionLimits } from "./completion-guard.js";
import {
  createScopedTelemetry,
  instrumentToolRegistration,
  type ScopedMetricsSnapshot,
  type ScopedTelemetry,
} from "./observability.js";

/**
 * Host-supplied policy knobs.
 *
 * Two transports, and only one of them is `MemoryConfig` (design record
 * `docs/fork/P4-TUNING-DESIGN.md` §4.2.1):
 *
 * - Fields with a `MemoryConfig` counterpart (`reviewEveryTurns`,
 *   `nudgeToolCalls`, `recentMessages`) are folded into `config` below.
 * - `nudgeMode` and `minUserTurnsBeforeReview` have no config field; they are
 *   additive and MUST be passed explicitly where review-flush is mounted.
 *   Folding them into `config` would silently drop them.
 */
export interface ScopedMemoryTuning {
  /** `"turn" | "tool" | "either"`. Default `"either"` (upstream semantics). */
  readonly nudgeMode?: NudgeMode;
  /** Minimum user messages before any review. Default 3. */
  readonly minUserTurnsBeforeReview?: number;
  /** Turns between reviews; maps to `config.nudgeInterval`. */
  readonly reviewEveryTurns?: number;
  /** Tool calls that also trigger a review; maps to `config.nudgeToolCalls`. */
  readonly nudgeToolCalls?: number;
  /** Recent messages in the review prompt; maps to `config.reviewRecentMessages`. */
  readonly recentMessages?: number;
  /**
   * Enable background review and session flush. Maps to
   * `config.reviewEnabled`; upstream default true. A provider-loaded host has
   * no other route to this switch — `review-flush.ts` honours the config field
   * but `ProviderContext` has no `config` passthrough (P5 §8 R8 / PR-A).
   */
  readonly reviewEnabled?: boolean;
  /**
   * Inject this user's pinned `STANDING.md` into every prompt section.
   * Maps to `config.standingInstructionsEnabled`; upstream default true
   * (P5 §4.2). The switch lives here because upstream's config file is
   * AGENT_ROOT-bound and unreachable from a multi-tenant host.
   */
  readonly standingInstructions?: boolean;
  /**
   * Mount `session_search` and index the current session. Default true.
   * Additive (SESSION-SEARCH-DESIGN.md §4.1): upstream's `SessionSearchConfig`
   * has no enable bit — only `variant` — so this cannot fold into `config`
   * (Chain B). The agent-chat host does not pass `tuning` today, so on that
   * path the tool is always mounted; the switch is the opt-out for direct
   * `openScopedHermesMemory` users and tests.
   */
  readonly sessionSearch?: boolean;
}

export interface ScopedHermesOptions extends ScopedRootInput {
  /** Overrides spread on top of `defaultMemoryConfig()`. Never read from disk. */
  readonly config?: Partial<MemoryConfig>;
  /**
   * Host-supplied policy knobs. Config-mapped fields merge into `config`;
   * additive fields (`nudgeMode`, `minUserTurnsBeforeReview`) are passed
   * explicitly to the review/flush mount.
   */
  readonly tuning?: ScopedMemoryTuning;
  /** Inject the memory policy prompt on `before_agent_start`. Default: true. */
  readonly injectPrompt?: boolean;
  /**
   * Per-turn automatic retrieval (v0.7 slice): on relevant user turns, query
   * this scope's FTS5 mirror and inject a bounded `<retrieved-memory>` block.
   * Default: true. Disable for hosts that own per-turn context entirely.
   */
  readonly autoRetrieve?: boolean;
  /** Token/query budgets for automatic retrieval. Requests may only tighten. */
  readonly retrievalBudget?: RetrievalBudget;
  /** Max characters of shared profile injected into the prompt. Default: 1200. */
  readonly profilePromptChars?: number;
  /**
   * Host-injected background LLM completion. When present, auto-consolidation
   * is mounted; when absent, the tenant still reads/writes/searches normally.
   */
  readonly complete?: MemoryCompletion;
  /**
   * Read-only view of this scope's saved sessions (SESSION-BACKFILL-DESIGN.md).
   * Optional: absent → no cross-session backfill, current-session indexing
   * continues unchanged. No import from the host protocol — structural shim.
   */
  readonly history?: MemoryHistoryPort;
  /**
   * Pre-built telemetry from the provider boundary. When omitted the entry
   * creates its own, so direct `openScopedHermesMemory` users get metrics too.
   */
  readonly telemetry?: ScopedTelemetry;
  /** Defensive provider-side limits for the injected completion. */
  readonly completionLimits?: CompletionLimits;
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
  /** Bounded observation window for this tenant. Never throws into callers. */
  readonly telemetry: ScopedTelemetry;
  /** Current aggregate metrics (success/P95/cost/tool failures). */
  metrics(): ScopedMetricsSnapshot;
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

  const telemetry = options.telemetry ?? createScopedTelemetry();
  const complete = guardCompletion(options.complete, {
    ...options.completionLimits,
    telemetry,
  });

  const tuning = options.tuning;
  // session_search (SESSION-SEARCH-DESIGN.md §4.1): Chain-B additive — no
  // MemoryConfig counterpart, read straight off tuning at the mount site.
  // Default on; the only off path is an explicit `false` from a direct user
  // (the agent-chat host never passes tuning).
  const sessionSearchEnabled = tuning?.sessionSearch !== false;
  const config: MemoryConfig = {
    ...defaultMemoryConfig(),
    ...options.config,
    // Chain A: only fields that exist on MemoryConfig are folded here. The
    // additive knobs (nudgeMode, minUserTurnsBeforeReview) are NOT config
    // fields and are passed explicitly at the mount site — see Chain B there.
    ...(tuning?.reviewEveryTurns !== undefined ? { nudgeInterval: tuning.reviewEveryTurns } : {}),
    ...(tuning?.nudgeToolCalls !== undefined ? { nudgeToolCalls: tuning.nudgeToolCalls } : {}),
    ...(tuning?.recentMessages !== undefined ? { reviewRecentMessages: tuning.recentMessages } : {}),
    // Chain A: reviewEnabled is a real MemoryConfig field, so it folds here.
    // Chain B's additive knobs are passed to setupScopedReviewFlush below.
    ...(tuning?.reviewEnabled !== undefined ? { reviewEnabled: tuning.reviewEnabled } : {}),
    // Chain A: standingInstructions maps to a config field; do NOT also pass
    // it at a mount site (contrast P4 §4.2.1 Chain B).
    ...(tuning?.standingInstructions !== undefined
      ? { standingInstructionsEnabled: tuning.standingInstructions } : {}),
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

  // P5 #8: user-pinned directives, read-only from the agent's side. The store
  // is created iff the switch is on; its only consumer is promptSection(), so
  // no tool, hook or provider handle can write the always-injected block.
  // Only the user's editor (or the host) can put text into layout.standingFile.
  const standingStore = config.standingInstructionsEnabled === false
    ? null
    : new StandingInstructions(layout.standingFile);

  // Loaded lazily on first render and memoised: loading at open() would miss
  // pins a host writes between open() and prompt assembly; reloading per turn
  // would cost an fs read every turn. Mid-session edits take effect at the next
  // open() (P5 §8 R5, matching upstream's once-per-session_start load).
  let standingLoad: Promise<void> | null = null;
  const ensureStanding = (): Promise<void> => {
    if (standingStore === null) return Promise.resolve();
    standingLoad ??= standingStore.load().catch((error: unknown) => {
      // An unreadable pins file must never fail prompt assembly (the session
      // would not open at all). Same best-effort shape as `ready` above.
      queueMicrotask(() => {
        console.error("[scoped-hermes] standing instructions load failed:", error);
      });
    });
    return standingLoad;
  };

  // The FTS5 search mirror is a per-tenant SQLite file living next to this
  // scope's Markdown. It is NOT shared with other scopes of the same user:
  // sharing it would let one scope's reindex rewrite another's search results
  // and would make erasure ambiguous. Markdown stays the source of truth —
  // every mirror row can be rebuilt by reconciling from disk.
  const dbManager = new DatabaseManager(layout.memoryDir);
  const dbLockPath = path.join(layout.memoryDir, ".pi-hermes-locks.sqlite");

  let disposed = false;
  let mounted = false;

  // Reuse upstream's teardown guard mechanism (`src/index.ts:138`): once this
  // handle has closed its mirror DB, any later `getDb()` throws
  // DATABASE_CLOSED_MESSAGE instead of silently re-opening a file nobody
  // tracks. Upstream needs it because a live-index timer can outlive its own
  // `session_shutdown` close (#313); scoped needs the same because a host
  // that violates the dispose-last contract could otherwise hand writes to a
  // handle `dispose()`/`erase()` already released — and on Windows that
  // reopened handle is what makes `erase()` fail with EBUSY. The message is
  // the one `reportScopedIndexFailure`/`isDatabaseClosedError` already skip.
  let dbClosed = false;
  dbManager.setOpenGuard(() => {
    if (dbClosed) throw new Error(DATABASE_CLOSED_MESSAGE);
  });

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
    .then(async () => {
      seedSearchMirror();
      // Recovery sidecars converge only here: a store that stops being written
      // never reaches saveToDisk, so stale .recovery-* / .retired-* files would
      // otherwise live forever. The layered facade fans this out to both roots;
      // upstream's runRecoveryMaintenance is not usable here — it walks a
      // projectsRoot and constructs stores from disk paths (tenant model has
      // neither). Best-effort: the catch below logs instead of failing open.
      await store.maintainRecoveryFiles();
    })
    .catch((error: unknown) => {
      // Surface the failure without turning it into an unhandled rejection when
      // the host never awaits `ready`.
      queueMicrotask(() => {
        console.error("[scoped-hermes] initial load failed:", error);
      });
    });

  // Host history port (SESSION-BACKFILL-DESIGN.md): lazy, bounded, best-effort.
  // Starts after `ready`, not from mount() — a direct user who only calls
  // promptSection() still gets a backfilled mirror. `dbClosed` is set by both
  // dispose() and erase(), so a teardown mid-pass stops cleanly.
  let currentSessionId: string | null = null;
  if (sessionSearchEnabled && options.history) {
    // #4 retention (P6 design): prune BEFORE backfill starts. Both await `ready`;
    // prune's body is synchronous, so it completes before backfill's first
    // `await history.list()`. Default sessionRetentionDays = 0 → no task at all.
    if ((config.sessionRetentionDays ?? 0) > 0) {
      void runScopedSessionRetention(dbManager, config.sessionRetentionDays!, ready, () => dbClosed);
    }
    void startScopedHistoryBackfill(
      dbManager, options.history, ready,
      () => currentSessionId, () => dbClosed,
    );
  }

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
    await ensureStanding();
    const policy = buildScopedMemoryPolicy({
      // A flag may only be true when the matching tool is actually mounted in
      // mount() below — a prompt that promises an absent tool wastes model turns.
      hasSearch: true,
      // A flag may only be true when the handler is actually mounted. Retrieval
      // is skipped when the host owns the whole prompt (injectPrompt:false) —
      // claiming it then would promise a block that is never injected.
      hasAutoRetrieval: options.autoRetrieve !== false && options.injectPrompt !== false,
      hasSessionSearch: sessionSearchEnabled,
      hasSkills: false,
      hasProjectStore: false,
      hasSharedProfile: profileStore !== null,
    });
    // Order matches upstream (prompt-context.ts:65-70): policy, profile, then
    // the user's own directives last, so they read as the operative instruction
    // rather than recalled context. An empty STANDING.md filters out entirely
    // (standing-instructions.ts:156-158), so an unchanged tenant's text is
    // byte-identical.
    return [policy, profileSection(), standingStore?.formatForSystemPrompt() ?? ""]
      .filter(Boolean)
      .join("\n\n");
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
    telemetry,
    metrics: () => telemetry.snapshot(),
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
            // A host with selfInjects:false already rendered the section. Strip
            // our own blocks first so the single surviving copy is the fresh
            // one — a stale profile copy can diverge after a mid-session fix.
            promptOptions.appendSystemPrompt = replaceOwnedBlocks(
              String(promptOptions.appendSystemPrompt ?? ""),
              section,
            );
            return;
          }
          // 0.80.x–0.85.x: the returned string is the whole prompt, so the
          // strip runs over the assembled text rather than over an append slot.
          return { systemPrompt: replaceOwnedBlocks(event.systemPrompt, section) };
        });
      }

      // No project store in the scoped entry: the tenant root IS the scope, so
      // the per-cwd project layer would re-introduce a shared dimension the host
      // does not want. `()` keeps the tool's project argument inert. Passing the
      // dbManager is what mirrors writes into this tenant's FTS5 index; without
      // it the search tool is mounted but would never see new memories.
      // The tool proxy observes execute() outcomes at the provider boundary —
      // upstream tool files stay untouched, so an upstream merge costs nothing.
      const observedPi = instrumentToolRegistration(pi, telemetry);
      registerMemoryTool(observedPi, store, () => null, dbManager);
      registerMemorySearchTool(observedPi, dbManager, { usageTrackingEnabled: config.usageHitTrackingEnabled });
      // session_search + live indexing of the current session
      // (SESSION-SEARCH-DESIGN.md §4.2): the tool registers through the
      // metrics Proxy like the others; the index listeners attach to the raw
      // `pi` because they are handlers, not tool registrations. Gated by the
      // Chain-B flag above — hasSessionSearch in promptSection() reads the
      // same value, so prompt and mount can never diverge.
      if (sessionSearchEnabled) {
        mountScopedSessionSearch(observedPi, dbManager);
        attachScopedSessionIndex(pi, dbManager, ready, (id) => { currentSessionId = id; });
      }

      // Per-turn automatic retrieval is opt-out, not opt-in: it is the host-side
      // value of the v0.7 slice. It follows injectPrompt (a host that owns the
      // prompt entirely owns per-turn context too) and mounts after `ready` so
      // a first-turn query sees the seeded FTS mirror.
      if (options.autoRetrieve !== false) {
        attachRetrieval(pi, dbManager, {
          injectPrompt: options.injectPrompt,
          ready,
          ...(options.retrievalBudget ?? {}),
        });
      }

      // Auto-consolidation is opt-in by capability: only mount it when the host
      // injected a completion callback. The layered store routes this to the
      // scope store, which owns memory/failure (the profile is capped small and
      // never consolidated, by design — see layered-store.ts).
      if (complete !== undefined) {
        store.setConsolidator((target, signal) =>
          consolidateViaCompletion(store, { target, complete, signal }),
        );
        // Background review (turn-triggered) and flush (shutdown), using the
        // same injected completion. Off when no capability was injected.
        // Correction detection shares the gate with them: all three can fire
        // around turn_end, and only one may apply memory operations at a time.
        const backgroundGate = createBackgroundGate();
        setupScopedReviewFlush(pi, {
          store,
          complete,
          gate: backgroundGate,
          // Chain A: thresholds travel inside `config`.
          config,
          // Chain B: additive knobs have no config counterpart; passing them any
          // other way silently drops them (P4-TUNING-DESIGN.md §4.2.1).
          nudgeMode: tuning?.nudgeMode,
          minUserTurnsBeforeReview: tuning?.minUserTurnsBeforeReview,
        });
        setupScopedCorrectionDetector(pi, { store, complete, config, gate: backgroundGate });
      }
    },
    async erase(eraseOptions?: EraseOptions) {
      // Erasure is a provider-level operation, so its metric belongs here (not
      // in the provider descriptor) — direct entry users get the same signal.
      return telemetry.measure("erase", undefined, async () => {
        await ready;
        // Close pinned connections first: Windows refuses to unlink an open file.
        // Both the markdown-mutation lock and the SQLite handle/lock live under
        // storageRoot, so all three must be released before the recursive rm.
        dbClosed = true;
        dbManager.close();
        AtomicLockCoordinator.shared(dbLockPath).closeHandle();
        releaseLock(roots.storageRoot);
        await fs.rm(roots.storageRoot, { recursive: true, force: true });
        claimedRoots.delete(layout.memoryDir);

        if (eraseOptions?.includeShared && roots.sharedRoot !== null) {
          releaseLock(roots.sharedRoot);
          await fs.rm(roots.sharedRoot, { recursive: true, force: true });
        }
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await ready;
      dbClosed = true;
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
