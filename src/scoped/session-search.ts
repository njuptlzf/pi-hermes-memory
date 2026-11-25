/**
 * Scoped (multi-tenant) `session_search`: tool registration + current-session
 * live indexing.
 *
 * WHY THIS FILE EXISTS (forced constraint — `UPSTREAM-MAPPING.md` §3.1):
 * upstream's `registerSessionSearchTool`
 * (`src/tools/session-search-tool.ts`) evaluates
 * `DEFAULT_SESSIONS_DIR = path.join(AGENT_ROOT, 'sessions')` at **import time**
 * (:10, :30 → `src/paths.ts:5`), which reads `process.env` / `os.homedir()` and
 * violates the scoped boundary (`AGENTS.md`, host admission scan). The pure
 * functions it calls — `searchSessions`, `getIndexedMessageCount`,
 * `indexCurrentSession` — are REUSED, not re-derived; only the ~100-line tool
 * wrapper is restated here. If the planned lazy-constant divergence lands
 * (`docs/fork/divergences.json:104-116`), this wrapper can be deleted and
 * upstream's tool imported directly — but the scoped WORDING below must then
 * be re-applied, not inherited
 * (`docs/fork/SESSION-SEARCH-DESIGN.md` §4.2 "Wording is not part of the copy", R1).
 *
 * Deliberate decisions recorded in the design record:
 * - `config.sessionSearch.variant` is IGNORED; the scoped mount is always the
 *   legacy SQLite variant. The anchors variant scans JSONL files a tenant does
 *   not have (§8 R3).
 * - `project` stays a filter over the cwd-derived label on `sessions.project`,
 *   not a project axis; no project store is introduced (§8 R4).
 * - Indexing calls `indexCurrentSession`, never `indexLiveSession`:
 *   agent-chat's `SessionManager` has `getSessionFile` but it returns
 *   `undefined`, and `indexLiveSessionOnce` bails on exactly that (§3.1 trap).
 * - `getEntries()` includes abandoned-branch entries (Pi retry/compaction
 *   branches); accepted as upstream-aligned (§8 R9).
 *
 * The snippet/output caps below are copied from
 * `src/tools/session-search-tool.ts:31-33` because those constants are
 * module-private there (not exported, `constants.ts` has no counterpart).
 * They are fork-visible literals until the wrapper is deleted; drift risk is
 * tracked by §8 R1.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { isDatabaseClosedError, type DatabaseManager } from "../store/db.js";
import type { MemoryHistoryPort } from "./history-types.js";
import { getIndexedMessageCount, searchSessions } from "../store/session-search.js";
import { indexCurrentSession } from "../store/session-indexer.js";
import { createSharedToolResultRenderer } from "../tools/shared-output-view.js";
import { searchResultView } from "../tools/tool-result-views.js";

const DEFAULT_SNIPPET_CHARS = 1_200;
const MAX_SNIPPET_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 50 * 1024;

interface ScopedSessionSearchResult {
  success: boolean;
  count?: number;
  message?: string;
  output?: string;
  outputChars?: number;
  outputTruncated?: boolean;
  snippetChars?: number;
  truncatedCount?: number;
}

function truncateSnippet(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: `${text.slice(0, maxChars)}\n... (truncated, ${text.length} chars total — refine the query or increase snippetChars)`,
    truncated: true,
  };
}

function capOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  const suffix = `\n... (output truncated, ${text.length} chars total — refine the query or lower the result limit)`;
  return { text: `${text.slice(0, MAX_OUTPUT_CHARS - suffix.length)}${suffix}`, truncated: true };
}

/**
 * Register the scoped `session_search` tool against this tenant's SQLite
 * mirror. Register through the metrics Proxy at the entry boundary so the
 * call is observed like every other tool.
 */
export function mountScopedSessionSearch(pi: ExtensionAPI, dbManager: DatabaseManager): void {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    // Scoped wording — the legacy upstream description promises "past
    // sessions" recall and a /memory-index-sessions command; this slice
    // indexes only the CURRENT session (SESSION-SEARCH-DESIGN.md §0/§2), and
    // under rpc the command would be inert. Do not "sync" these strings back
    // to upstream's; §7 test 10 pins them.
    description: `Search the current session's conversation history verbatim. Use this when the user asks what was said earlier in THIS conversation — the exact wording of a decision, an error message that was pasted, a detail a summary would lose. For durable facts stored in memory, use memory_search instead.

Examples:
- "What exactly did we decide about the migration order?"
- "Find the error message I pasted earlier"
- "How did I phrase the retry policy requirement?"

Returns bounded conversation snippets with roles and timestamps from this session only. Large messages are truncated with their original character count.`,
    promptSnippet: "Search this session's earlier messages verbatim",
    promptGuidelines: [
      "Use session_search when the exact earlier wording matters more than a summary.",
      "session_search covers this conversation only; use memory_search for durable facts.",
    ],
    renderResult: createSharedToolResultRenderer(searchResultView),
    parameters: Type.Object({
      query: Type.String({ description: "Search query. Use natural language or specific terms." }),
      project: Type.Optional(Type.String({ description: "Filter by the session's project label (optional; in this deployment it is derived from the working directory, not a project store)." })),
      role: Type.Optional(StringEnum(["user", "assistant"] as const, { description: "Filter by message role (optional)." })),
      limit: Type.Optional(Type.Number({
        description: "Maximum results to return (default: 10, min: 1, max: 20).",
        minimum: 1,
        maximum: 20,
      })),
      snippetChars: Type.Optional(Type.Number({
        description: `Maximum characters per result snippet (default: ${DEFAULT_SNIPPET_CHARS}, max: ${MAX_SNIPPET_CHARS}).`,
        minimum: 100,
        maximum: MAX_SNIPPET_CHARS,
      })),
    }),
    execute: async (
      _id: string,
      args: { query: string; project?: string; role?: string; limit?: number; snippetChars?: number },
    ) => {
      const query = args.query;
      const requestedLimit = Number.isFinite(args.limit) ? Math.floor(args.limit!) : 10;
      const limit = Math.min(Math.max(requestedLimit, 1), 20);
      const requestedSnippetChars = Number.isFinite(args.snippetChars)
        ? Math.floor(args.snippetChars!)
        : DEFAULT_SNIPPET_CHARS;
      const snippetChars = Math.min(Math.max(requestedSnippetChars, 100), MAX_SNIPPET_CHARS);

      if (!query || query.trim().length === 0) {
        const result: ScopedSessionSearchResult = { success: false, message: "query is required" };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      const totalMessages = getIndexedMessageCount(dbManager);
      if (totalMessages === 0) {
        // No slash command here: registerCommand is inert under rpc and the
        // tenant has no sessions directory to import (SESSION-SEARCH-DESIGN.md §4.2).
        const result: ScopedSessionSearchResult = {
          success: false,
          message: "No messages indexed yet. This session is indexed automatically as each turn ends.",
        };
        return { content: [{ type: "text" as const, text: result.message! }], details: result };
      }

      const results = searchSessions(dbManager, query, {
        project: args.project,
        role: args.role,
        limit,
      });

      if (results.length === 0) {
        const output = capOutput("No results found. Try a different search term or broader query.");
        const result: ScopedSessionSearchResult = {
          success: true,
          count: 0,
          message: output.text,
          outputChars: output.text.length,
          outputTruncated: output.truncated,
        };
        return { content: [{ type: "text" as const, text: output.text }], details: result };
      }

      const blocks: string[] = [`Found ${results.length} results for "${query}":`];
      let truncatedCount = 0;

      for (const r of results) {
        const date = new Date(r.timestamp).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        const snippet = truncateSnippet(r.snippet, snippetChars);
        if (snippet.truncated) truncatedCount += 1;
        blocks.push([
          "---",
          `📅 ${date} | 📁 ${r.project} | ${r.role === "user" ? "👤 User" : "🤖 Assistant"}`,
          snippet.text,
        ].join("\n"));
      }

      const output = capOutput(blocks.join("\n\n").trim());
      const finalResult: ScopedSessionSearchResult = {
        success: true,
        count: results.length,
        truncatedCount,
        snippetChars,
        outputChars: output.text.length,
        outputTruncated: output.truncated,
      };
      return { content: [{ type: "text" as const, text: output.text }], details: finalResult };
    },
  });
}

/**
 * Index the live session into this tenant's mirror on every `turn_end` and a
 * final time on `session_shutdown`. Best-effort by contract: indexing must
 * never break a turn or fail teardown, but a real failure is still reported
 * (skip-closed / report-rest, mirroring upstream's
 * `reportLiveSessionIndexError` from issue #313).
 *
 * Listeners attach to the raw `pi` — they are handlers, not tool registrations,
 * so they do not need (and must not receive) the tool metrics Proxy.
 */
export function attachScopedSessionIndex(
  pi: ExtensionAPI,
  dbManager: DatabaseManager,
  isReady: Promise<void>,
  onHeader?: (id: string | null) => void,
): void {
  const noteHeader = (ctx: ExtensionContext): void => {
    // The backfill reconcile must never delete the session that is live
    // right now (SESSION-BACKFILL-DESIGN.md §2.4/B5). Before the first turn
    // the id is null and nothing is protected.
    const sm = ctx.sessionManager as { getHeader?: () => { id?: string } | null };
    onHeader?.(typeof sm?.getHeader === "function" ? (sm.getHeader()?.id ?? null) : null);
  };

  pi.on("turn_end", async (_event, ctx: ExtensionContext) => {
    noteHeader(ctx);
    await isReady; // dbManager is open; memory mirrors are seeded first
    try {
      dbManager.withCorruptionRecovery(() => indexCurrentSession(dbManager, ctx.sessionManager));
    } catch (error) {
      reportScopedIndexFailure(error);
    }
  });

  pi.on("session_shutdown", async (_event, ctx: ExtensionContext) => {
    noteHeader(ctx);
    await isReady;
    try {
      dbManager.withCorruptionRecovery(() => indexCurrentSession(dbManager, ctx.sessionManager));
    } catch (error) {
      reportScopedIndexFailure(error);
    }
  });
}

/**
 * Consume the host's read-only history port (SESSION-BACKFILL-DESIGN.md).
 * Reuses the shipped live-index parser: `exportHistory` entries have the same
 * shape as `SessionManager` accessors, so a two-closure snapshot is enough —
 * no new parser, no file I/O, no upstream file touched.
 */
const BACKFILL_CURSOR_KEY = "scoped_session_backfill";
/** Aligned to upstream's `maxFilesToIndex ?? 50` (`session-indexer.ts:457`). */
const BACKFILL_SESSIONS_PER_OPEN = 50;

type BackfillCursor = Record<string, string>;

function readBackfillCursor(db: ReturnType<DatabaseManager["getDb"]>): BackfillCursor {
  const row = db.prepare("SELECT value FROM extension_metadata WHERE key = ?")
    .get(BACKFILL_CURSOR_KEY) as { value?: string } | undefined;
  if (!row?.value) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: BackfillCursor = {};
      for (const [id, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[id] = value;
      }
      return out;
    }
  } catch { /* stale/corrupt cursor = fresh start; indexCurrentSession is idempotent */ }
  return {};
}

function writeBackfillCursor(db: ReturnType<DatabaseManager["getDb"]>, cursor: BackfillCursor): void {
  db.prepare(`
    INSERT INTO extension_metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(BACKFILL_CURSOR_KEY, JSON.stringify(cursor));
}

function validHistoryHeader(entry: unknown): entry is { id: string; timestamp: string; cwd: string } {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as { type?: unknown; id?: unknown; timestamp?: unknown; cwd?: unknown };
  return e.type === "session"
    && typeof e.id === "string" && e.id.length > 0
    && typeof e.timestamp === "string" && e.timestamp.length > 0
    && typeof e.cwd === "string" && e.cwd.length > 0;
}

/**
 * One bounded backfill pass, callable directly by tests. A session is only
 * loaded when its `updatedAt` changed; a failed/missing load leaves the cursor
 * alone so the next open retries. Reconcile uses the port's authoritative
 * id set — the current live session is unconditionally protected (B5).
 */
export async function backfillScopedHistoryOnce(
  dbManager: DatabaseManager,
  history: MemoryHistoryPort,
  currentSessionId: () => string | null,
  isDisposed: () => boolean = () => false,
): Promise<void> {
  const db = dbManager.getDb();
  const cursor = readBackfillCursor(db);
  const sessions = await history.list(); // failure propagates to start's catch
  const listed = new Set(sessions.map((s) => s.sessionId));
  let budget = 0;

  for (const s of sessions) {
    if (isDisposed()) return; // B4: no writes into a released handle
    if (budget++ >= BACKFILL_SESSIONS_PER_OPEN) break;
    if (cursor[s.sessionId] === s.updatedAt) continue;

    const entries = await history.load(s.sessionId);
    if (!entries) continue; // B6: undefined = not yet indexable, retry next open
    const header = entries.find(validHistoryHeader);
    if (!header) {
      cursor[s.sessionId] = s.updatedAt; // don't retry junk every open
      continue;
    }
    const snapshot = {
      getHeader: () => header,
      getEntries: () => entries.filter((e) => e !== header),
    };
    dbManager.withCorruptionRecovery(() =>
      indexCurrentSession(dbManager, snapshot as Parameters<typeof indexCurrentSession>[1]));
    cursor[s.sessionId] = s.updatedAt;
  }

  // Reconcile: only ids this port has backfilled are deletion candidates;
  // live-indexed-only ids are structurally outside the cursor.
  const liveId = currentSessionId();
  const deleted = Object.keys(cursor).filter((id) => !listed.has(id) && id !== liveId);
  if (deleted.length > 0) {
    dbManager.withCorruptionRecovery(() => {
      const d = dbManager.getDb();
      for (let i = 0; i < deleted.length; i += 100) {
        const chunk = deleted.slice(i, i + 100);
        const marks = chunk.map(() => "?").join(",");
        d.prepare(`DELETE FROM messages WHERE session_id IN (${marks})`).run(...chunk);
        d.prepare(`DELETE FROM sessions WHERE id IN (${marks})`).run(...chunk);
      }
    });
    for (const id of deleted) delete cursor[id];
  }
  writeBackfillCursor(dbManager.getDb(), cursor);
}

/**
 * Fire-and-forget after `ready`, deliberately not awaited by mount/prompt.
 * Real failures take the same best-effort channel as live indexing; a closed
 * DB is teardown noise and is skipped there.
 */
export function startScopedHistoryBackfill(
  dbManager: DatabaseManager,
  history: MemoryHistoryPort,
  isReady: Promise<void>,
  currentSessionId: () => string | null,
  isDisposed: () => boolean,
): Promise<void> {
  return isReady
    .then(() => backfillScopedHistoryOnce(dbManager, history, currentSessionId, isDisposed))
    .catch((error: unknown) => reportScopedIndexFailure(error));
}

/**
 * Closed DB is teardown noise (dispose/erase already ran); anything else is a
 * real failure and must be observable. The queueMicrotask + console.error shape
 * follows the entry's own best-effort precedent (`seedSearchMirror`,
 * entry.ts:284-291) so a failed index surfaces the same way as a failed mirror
 * seed — visible, non-fatal. Deliberately not telemetry: `ScopedTelemetry`
 * re-throws from `measure` and its `operation` union is closed, so metricizing
 * index failures is a follow-up that widens `ScopedOperation`
 * (SESSION-SEARCH-DESIGN.md §4.3). Exported for tests, mirroring upstream's
 * `reportLiveSessionIndexError`.
 */
export function reportScopedIndexFailure(error: unknown): void {
  if (isDatabaseClosedError(error)) return;
  queueMicrotask(() => {
    console.error("[scoped-hermes] session index failed:", error);
  });
}
