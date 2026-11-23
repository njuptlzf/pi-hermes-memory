/**
 * Scoped (in-process host) background review + session flush via the injected
 * completion callback.
 *
 * Mirrors the full entry's behaviour at the boundary the host can support, and
 * depends on the same source of truth: thresholds are READ from `MemoryConfig`
 * (`nudgeInterval`, `nudgeToolCalls`, `reviewRecentMessages`, `reviewEnabled`)
 * rather than copied as literals. See `docs/fork/P4-TUNING-DESIGN.md`.
 *
 * Counting differs from the old scoped code on purpose: it counts `turn_end`
 * (assistant turns, including tool loops) like upstream, not user messages.
 * That model drops the implicit "at least N user messages" protection the user
 * message counter used to give for free, so `minUserTurnsBeforeReview`
 * restores it — the equivalent of upstream's `userTurnCount < 3` guard.
 *
 * Both read the conversation from the pi session's own `sessionManager` (the
 * host owns history), build the same prompts as the full entry, and apply
 * operations through the shared `runMemoryOps` runner — no spawn, no env, no
 * model/credential access.
 *
 * Bounded: review is turn-triggered with an in-flight guard (never concurrent),
 * flush runs at most once. Every failure is swallowed — a missed review/flush
 * is recoverable, a broken session is not.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBackgroundGate, type BackgroundGate } from "./background-gate.js";
import type { MemoryCompletion } from "./completion-types.js";
import { runMemoryOps } from "./memory-ops.js";
import type { MemoryStore } from "../store/memory-store.js";
import { defaultMemoryConfig } from "../config.js";
import { collectMessageParts } from "../handlers/message-parts.js";
import { buildDirectReviewUserPrompt } from "../handlers/background-review.js";
import {
  DIRECT_FLUSH_SYSTEM_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  buildMemoryTargetRoutingGuidance,
} from "../constants.js";
import type { MemoryConfig } from "../types.js";

/**
 * Which counter may trigger a review.
 *
 * - `turn`   — assistant turns only (`nudgeInterval`).
 * - `tool`   — tool calls only (`nudgeToolCalls`).
 * - `either` — whichever threshold is met first. Upstream's semantics.
 */
export type NudgeMode = "turn" | "tool" | "either";

export interface ScopedReviewFlushOptions {
  readonly store: MemoryStore;
  readonly complete: MemoryCompletion;
  /**
   * Upstream config source. Thresholds are read from it, not restated. When
   * omitted, `defaultMemoryConfig()` supplies upstream's defaults.
   */
  readonly config?: MemoryConfig;
  /**
   * Which counter may trigger a review. Default `"either"` (upstream
   * semantics: turn OR tool calls, whichever comes first).
   */
  readonly nudgeMode?: NudgeMode;
  /**
   * Minimum user messages before any review. Default 3 (matches upstream).
   *
   * Required because counting turns instead of user messages removes the
   * implicit protection the old `userTurns < N` check provided: one long
   * tool-driven turn can satisfy `either` while the user has said one
   * sentence, which writes noise into memory.
   */
  readonly minUserTurnsBeforeReview?: number;
  /** Overrides `config.nudgeInterval`. */
  readonly reviewEveryTurns?: number;
  /** Overrides `config.nudgeToolCalls`. */
  readonly nudgeToolCalls?: number;
  /** Overrides `config.reviewRecentMessages` (0 = all messages, as upstream). */
  readonly recentMessages?: number;
  /**
   * Shared with correction detection so a review and a correction never call
   * `runMemoryOps` concurrently on the same store. A standalone caller gets a
   * private gate and keeps the previous in-flight behaviour.
   */
  readonly gate?: BackgroundGate;
}

function conversationParts(ctx: ExtensionContext, recentMessages: number): string[] | null {
  try {
    return collectMessageParts(ctx.sessionManager.getBranch(), recentMessages);
  } catch {
    return null; // context already stale
  }
}

function currentMemory(store: MemoryStore): string {
  return [
    "--- Current Memory ---",
    store.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    "",
    "--- Current User Profile ---",
    store.getUserEntries().join(ENTRY_DELIMITER) || "(empty)",
  ].join("\n");
}

/**
 * Mount scoped review (turn-triggered) and flush (shutdown-triggered).
 *
 * No-op beyond tool registration if the host did not inject `complete` — the
 * caller decides whether to invoke this at all.
 */
export function setupScopedReviewFlush(pi: ExtensionAPI, options: ScopedReviewFlushOptions): void {
  const { store, complete } = options;
  const config = options.config ?? defaultMemoryConfig();

  // Thresholds: explicit option → config → upstream default. No fourth source
  // and no scoped-only literal (see the porting standard).
  const nudgeInterval = Math.max(1, options.reviewEveryTurns ?? config.nudgeInterval);
  const nudgeToolCalls = Math.max(1, options.nudgeToolCalls ?? config.nudgeToolCalls);
  const recentMessages = options.recentMessages ?? config.reviewRecentMessages ?? 0;
  const nudgeMode: NudgeMode = options.nudgeMode ?? "either";
  const minUserTurns = Math.max(0, options.minUserTurnsBeforeReview ?? 3);
  const gate = options.gate ?? createBackgroundGate();

  let userMessages = 0;
  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let flushed = false;

  pi.on("message_end", async (event) => {
    if (event.message?.role === "user") userMessages++;
  });

  pi.on("turn_end", async (event, ctx) => {
    // Count before any early return: the counters are state, not a decision.
    turnsSinceReview++;
    toolCallsSinceReview += event.toolResults?.length ?? 0;

    // A host-injected `reviewEnabled: false` must actually stop the work.
    if (config.reviewEnabled === false) return;
    // The guard the turn-based model no longer inherits for free.
    if (userMessages < minUserTurns) return;

    const byTurn = turnsSinceReview >= nudgeInterval;
    const byTool = toolCallsSinceReview >= nudgeToolCalls;
    const due = nudgeMode === "turn" ? byTurn : nudgeMode === "tool" ? byTool : byTurn || byTool;
    if (!due) return;

    // Claim the shared slot before reading state. If correction detection holds
    // it, skip this round but keep the counters so a later turn still reviews.
    if (!gate.tryStart()) return;
    const parts = conversationParts(ctx, recentMessages);
    if (!parts || parts.length === 0) {
      gate.finish();
      return;
    }

    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
    try {
      const userPrompt = buildDirectReviewUserPrompt({
        parts,
        currentMemory: store.getMemoryEntries().join(ENTRY_DELIMITER),
        currentUser: store.getUserEntries().join(ENTRY_DELIMITER),
        currentProject: null,
      });
      await runMemoryOps({
        store,
        systemPrompt: [DIRECT_REVIEW_SYSTEM_PROMPT, "", buildMemoryTargetRoutingGuidance(false)].join("\n"),
        userPrompt,
        complete,
      });
      // Failure already structured inside runMemoryOps; nothing to surface here.
    } catch {
      // Never let background review break the session.
    } finally {
      gate.finish();
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (flushed) return;
    flushed = true;
    if (config.reviewEnabled === false) return;
    if (turnsSinceReview === 0) return; // nothing new since the last review
    // Do not start a flush while a correction/review still holds the slot.
    // Flush is best-effort, so skipping beats a concurrent write at teardown.
    if (!gate.tryStart()) return;
    const parts = conversationParts(ctx, recentMessages);
    if (!parts || parts.length === 0) {
      gate.finish();
      return;
    }

    try {
      await runMemoryOps({
        store,
        systemPrompt: [DIRECT_FLUSH_SYSTEM_PROMPT, "", buildMemoryTargetRoutingGuidance(false)].join("\n"),
        userPrompt: [currentMemory(store), "", "--- Conversation ---", parts.join("\n\n")].join("\n"),
        complete,
      });
    } catch {
      // Flush is best-effort at teardown.
    } finally {
      gate.finish();
    }
  });
}
