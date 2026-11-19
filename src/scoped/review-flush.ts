/**
 * Scoped (in-process host) background review + session flush via the injected
 * completion callback.
 *
 * Mirrors the full entry's behaviour at the boundary the host can support:
 * review after N user turns, flush once at shutdown. Both read the conversation
 * from the pi session's own `sessionManager` (the host owns history), build the
 * same prompts as the full entry, and apply operations through the shared
 * `runMemoryOps` runner — no spawn, no env, no model/credential access.
 *
 * Bounded: review is turn-triggered with an in-flight guard (never concurrent),
 * flush runs at most once. Every failure is swallowed — a missed review/flush
 * is recoverable, a broken session is not.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryCompletion } from "./completion-types.js";
import { runMemoryOps } from "./memory-ops.js";
import type { MemoryStore } from "../store/memory-store.js";
import { collectMessageParts } from "../handlers/message-parts.js";
import { buildDirectReviewUserPrompt } from "../handlers/background-review.js";
import {
  DIRECT_FLUSH_SYSTEM_PROMPT,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  buildMemoryTargetRoutingGuidance,
} from "../constants.js";

export interface ScopedReviewFlushOptions {
  readonly store: MemoryStore;
  readonly complete: MemoryCompletion;
  /** User turns between background reviews. Default 6. */
  readonly reviewEveryTurns?: number;
  /** How many recent messages to include. Default 20. */
  readonly recentMessages?: number;
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
  const reviewEvery = Math.max(1, options.reviewEveryTurns ?? 6);
  const recentMessages = options.recentMessages ?? 20;

  let userTurns = 0;
  let inFlight = false;
  let flushed = false;

  pi.on("message_end", async (event) => {
    if (event.message?.role === "user") userTurns++;
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (userTurns < reviewEvery || inFlight) return;
    const parts = conversationParts(ctx, recentMessages);
    if (!parts || parts.length === 0) return;

    inFlight = true;
    userTurns = 0;
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
      inFlight = false;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (flushed) return;
    flushed = true;
    if (userTurns === 0) return; // nothing new since the last review
    const parts = conversationParts(ctx, recentMessages);
    if (!parts || parts.length === 0) return;

    try {
      await runMemoryOps({
        store,
        systemPrompt: [DIRECT_FLUSH_SYSTEM_PROMPT, "", buildMemoryTargetRoutingGuidance(false)].join("\n"),
        userPrompt: [currentMemory(store), "", "--- Conversation ---", parts.join("\n\n")].join("\n"),
        complete,
      });
    } catch {
      // Flush is best-effort at teardown.
    }
  });
}
