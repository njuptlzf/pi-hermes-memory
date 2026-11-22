/**
 * Scoped correction detection — immediate memory save when the user corrects
 * the agent, using the injected completion callback instead of a subprocess.
 *
 * This is the host-safe port of `src/handlers/correction-detector.ts`. The
 * detection filter (`isCorrection`) is reused as-is — it is a pure function.
 * Everything the host forbids is dropped: no `execChildPrompt` subprocess, no
 * model/modelRegistry (`runDirectMemoryCompletion`), no project store, no
 * `ctx.ui.notify`. The save goes through the shared `runMemoryOps` runner — the
 * same bounded, structured-failure path consolidation/review/flush use — plus
 * the automatic failure-memory capture.
 *
 * A correction and a periodic review can both fire on the same `turn_end`.
 * The shared `BackgroundGate` (injected by the entry) gives one of them the
 * slot so their `runMemoryOps` calls never overlap on the same store.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DIRECT_CORRECTION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
  buildMemoryTargetRoutingGuidance,
} from "../constants.js";
import { isCorrection } from "../handlers/correction-detector.js";
import { collectMessageParts } from "../handlers/message-parts.js";
import type { MemoryStore } from "../store/memory-store.js";
import { getMessageText } from "../types.js";
import type { MemoryConfig } from "../types.js";
import { createBackgroundGate, type BackgroundGate } from "./background-gate.js";
import type { MemoryCompletion } from "./completion-types.js";
import { runMemoryOps } from "./memory-ops.js";

/** Extract the directive part of a correction (mirrors the upstream helper). */
function extractCorrectionDirective(text: string): string {
  const cleaned = text
    .replace(/^(no|wrong|actually|stop|don'?t|that'?s not|I said|I told you)[,\.\s!]+/i, "")
    .replace(/^(please\s+)?/i, "")
    .trim();
  return cleaned || text;
}

export interface ScopedCorrectionOptions {
  readonly store: MemoryStore;
  readonly complete: MemoryCompletion;
  readonly config: MemoryConfig;
  /** Shared with review/flush so the two never apply operations concurrently. */
  readonly gate?: BackgroundGate;
  /** How many recent messages to include. Default 6 (same as upstream). */
  readonly recentMessages?: number;
  /** Minimum user turns between correction saves. Default 3 (same as upstream). */
  readonly minTurnsBetween?: number;
}

/**
 * Mount scoped correction detection.
 *
 * No-op when `config.correctionDetection` is false. Every failure is swallowed
 * — a missed correction save is recoverable, a broken session is not.
 */
export function setupScopedCorrectionDetector(
  pi: ExtensionAPI,
  options: ScopedCorrectionOptions,
): void {
  const { store, complete, config } = options;
  if (config.correctionDetection === false) return;

  const gate = options.gate ?? createBackgroundGate();
  const recentMessages = options.recentMessages ?? 6;
  const minTurns = Math.max(1, options.minTurnsBetween ?? 3);

  let pendingCorrection: string | undefined;
  // Start at the threshold so the first correction can fire immediately.
  let turnsSinceLastCorrection = minTurns;

  pi.on("message_end", async (event) => {
    if (event.message?.role !== "user") return;
    const text = getMessageText(event.message);
    if (!text) return;
    if (isCorrection(text, config)) {
      // Keep the most recent correction if several arrive in one turn.
      pendingCorrection = text;
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!pendingCorrection) {
      turnsSinceLastCorrection++;
      return;
    }
    if (turnsSinceLastCorrection < minTurns) return;

    // Try to claim the shared slot. If review/flush holds it, keep the
    // correction pending for a later turn rather than dropping it.
    if (!gate.tryStart()) return;

    const correctionText = pendingCorrection;
    pendingCorrection = undefined;
    turnsSinceLastCorrection = 0;

    try {
      const parts = collectMessageParts(ctx.sessionManager.getBranch(), recentMessages);
      const promptBody = [
        "--- Current Memory ---",
        store.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
        "",
        "--- Current User Profile ---",
        store.getUserEntries().join(ENTRY_DELIMITER) || "(empty)",
        "",
        "--- User Correction to Save ---",
        correctionText,
        "",
        "--- Recent Conversation ---",
        parts.join("\n\n"),
      ].join("\n");

      // No project store in scoped — routing guidance is fixed to scope-only.
      await runMemoryOps({
        store,
        systemPrompt: [
          DIRECT_CORRECTION_SYSTEM_PROMPT,
          "",
          buildMemoryTargetRoutingGuidance(false),
        ].join("\n"),
        userPrompt: promptBody,
        complete,
        signal: ctx.signal,
      });
      // Structured failure inside runMemoryOps; nothing to surface here.

      // Also capture the correction as a failure memory for learning. The
      // scoped entry has no project name, so that field is omitted.
      try {
        const directive = extractCorrectionDirective(correctionText);
        await store.addFailure(directive, {
          category: "correction",
          failureReason: "User corrected the agent",
          signal: ctx.signal,
        });
      } catch {
        // Best-effort — never block the session on failure-memory capture.
      }
    } catch {
      // Never let background correction break the session.
    } finally {
      gate.finish();
    }
  });
}
