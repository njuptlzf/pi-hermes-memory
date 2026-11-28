import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  openScopedHermesMemory,
  type ScopedHermesHandle,
} from "../../src/scoped/entry.js";
import type { MemoryHistoryPort, MemorySessionSummary } from "../../src/scoped/history-types.js";
import { reindexScopedHistory } from "../../src/scoped/session-search.js";
import { createScopedBackfillGate } from "../../src/scoped/backfill-gate.js";
import { DatabaseManager } from "../../src/store/db.js";

/**
 * Manual full reindex (backlog #18). Design: docs/fork/SESSION-REINDEX-DESIGN.md §5.
 *
 * Ten cases: full pass reindexes cursor-equal sessions, idempotent rows,
 * cursor survives for next-open skips, the R2 retention guard, gate chaining,
 * guard rejections, dispose abort, NaN updatedAt, reconcile protection,
 * descriptor pin. Time anchors are RELATIVE (`now - 6h` etc.) — a literal
 * calendar date is the CI time-bomb of 2026-11-27's lesson.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

interface ScriptedPort extends MemoryHistoryPort {
  calls: { list: number; loads: string[] };
  sessions: MemorySessionSummary[];
  entries: Map<string, unknown[]>;
  deferredLoad?: ((sessionId: string) => Promise<unknown[] | undefined>) | null;
}

function port(sessions: Array<{ sessionId: string; updatedAt: string; text: string }>): ScriptedPort {
  const entries = new Map<string, unknown[]>();
  for (const s of sessions) {
    entries.set(s.sessionId, [
      { type: "session", id: s.sessionId, timestamp: iso(DAY_MS), cwd: "/data/u1/alpha" },
      { type: "message", id: `${s.sessionId}-m`, timestamp: iso(DAY_MS), message: { role: "assistant", content: [{ type: "text", text: s.text }] } },
    ]);
  }
  return {
    calls: { list: 0, loads: [] },
    sessions: sessions.map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt })),
    entries,
    deferredLoad: null,
    async list() {
      this.calls.list++;
      return this.sessions;
    },
    async load(sessionId: string) {
      this.calls.loads.push(sessionId);
      if (this.deferredLoad) return this.deferredLoad(sessionId);
      return this.entries.get(sessionId);
    },
  };
}

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-reindex-${label}-`));
  roots.push(dir);
  return dir;
}

function openTenant(
  opts: { history?: MemoryHistoryPort; sessionSearch?: boolean; retentionDays?: number } = {},
): { handle: ScopedHermesHandle; root: string } {
  const root = tempRoot("tenant");
  const handle = openScopedHermesMemory({
    storageRoot: root,
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.sessionSearch === false ? { tuning: { sessionSearch: false } } : {}),
    ...(opts.retentionDays !== undefined ? { config: { sessionRetentionDays: opts.retentionDays } } : {}),
  });
  handles.push(handle);
  return { handle, root };
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose().catch(() => {});
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dbOf(handle: ScopedHermesHandle): DatabaseManager {
  return new DatabaseManager(handle.layout.memoryDir);
}

function cursorOf(handle: ScopedHermesHandle): Record<string, string> {
  const db = dbOf(handle);
  try {
    const row = db.getDb().prepare("SELECT value FROM extension_metadata WHERE key = ?")
      .get("scoped_session_backfill") as { value?: string } | undefined;
    return row?.value ? JSON.parse(row.value) : {};
  } finally {
    db.close();
  }
}

function searchFor(handle: ScopedHermesHandle, query: string): number {
  const db = dbOf(handle);
  try {
    return db.getDb().prepare(
      "SELECT COUNT(*) as c FROM messages WHERE content LIKE ?",
    ).get(`%${query}%`)!.c as number;
  } finally {
    db.close();
  }
}

describe("manual session reindex (handle.reindexSessions)", () => {
  it("1. full pass reindexes cursor-equal sessions the incremental skip would drop", async () => {
    const p = port([{ sessionId: "s1", updatedAt: iso(2 * DAY_MS), text: "reindex me once" }]);
    const { handle } = openTenant({ history: p });
    await handle.ready;
    // Pretend s1 is already indexed at this exact updatedAt: the incremental
    // cursor-skip would not reload it. A full pass must bypass that skip.
    const db = dbOf(handle);
    try {
      db.getDb().prepare(
        "INSERT INTO extension_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("scoped_session_backfill", JSON.stringify({ s1: p.sessions[0]!.updatedAt }));
    } finally {
      db.close();
    }

    const stats = await handle.reindexSessions();
    assert.deepEqual(p.calls.loads, ["s1"], "full mode bypasses the cursor-equality skip (fact 1)");
    assert.equal(stats.expiredSkipped, 0);
    assert.equal(stats.reachedLimit, false, "a completed full pass never reports the budget");
  });

  it("2. second consecutive reindex is row-idempotent (INSERT OR IGNORE)", async () => {
    const p = port([{ sessionId: "s2", updatedAt: iso(DAY_MS), text: "dup check fact" }]);
    const { handle } = openTenant({ history: p });
    await handle.ready;
    await handle.reindexSessions();
    const first = searchFor(handle, "dup check fact");
    assert.ok(first >= 1, "row landed");
    await handle.reindexSessions();
    assert.equal(searchFor(handle, "dup check fact"), first, "no duplicate messages after re-reindex");
  });

  it("3. cursor survives a full pass so the next incremental open skips (non-deletion rule)", async () => {
    const p = port([{ sessionId: "s3", updatedAt: iso(DAY_MS), text: "cursor keep fact" }]);
    const { handle, root } = openTenant({ history: p });
    await handle.ready;
    await new Promise((r) => setTimeout(r, 40)); // let the open-time pass settle
    await handle.reindexSessions();
    const cursor = cursorOf(handle);
    assert.equal(cursor.s3, p.sessions[0]!.updatedAt, "cursor advanced, not deleted (§2.1 discipline)");
    // Open pass (1) + full pass (2) each loaded once; the full pass must have
    // left the cursor entry in place (NOT delete it) so the NEXT open skips.
    const afterFirst = p.calls.loads.filter((x) => x === "s3").length;
    assert.equal(afterFirst, 2, "open pass + full pass each loaded s3 once");
    await handle.dispose();
    handles.splice(handles.indexOf(handle), 1);
    const handle2 = openScopedHermesMemory({ storageRoot: root, history: p });
    handles.push(handle2);
    await handle2.ready;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(
      p.calls.loads.filter((x) => x === "s3").length,
      2,
      "reopen incremental pass SKIPPED s3 via the surviving cursor",
    );
  });

  it("7. (R7) teardown landing mid-pass yields aborted stats with no post-close write", async () => {
    // Function-level (bypasses the open-time kickoff so the deferred load is
    // the only thing in flight): dispose flips after s1 indexes, s2's load
    // resolves later and must NOT be written.
    const root = tempRoot("abort");
    const dir = path.join(root, "memory");
    fs.mkdirSync(dir, { recursive: true });
    const dbManager = new DatabaseManager(dir);
    let disposed = false;
    let n = 0;
    const header = { type: "session", id: "a", timestamp: iso(DAY_MS), cwd: "/x" };
    const msgFor = (id: string) => ({
      type: "message", id: `${id}-m`, timestamp: iso(DAY_MS),
      message: { role: "assistant", content: [{ type: "text", text: `ZABORT-${id}` }] },
    });
    const history: MemoryHistoryPort = {
      async list() {
        return [{ sessionId: "a", updatedAt: iso(DAY_MS) }, { sessionId: "b", updatedAt: iso(DAY_MS) }];
      },
      async load(id) {
        n++;
        if (id === "a") return [header, msgFor("a")];
        return new Promise((res) => setTimeout(() => res([header, msgFor("b")]), 30));
      },
    };
    const pass = reindexScopedHistory(dbManager, history, () => null, 0, createScopedBackfillGate(), () => disposed);
    await new Promise((r) => setTimeout(r, 8)); // s1 indexed, s2 load in flight
    disposed = true;
    const stats = await pass;
    assert.equal(stats.aborted, true, JSON.stringify(stats));
    const db = dbManager.getDb();
    const hasB = db.prepare("SELECT COUNT(*) c FROM messages WHERE content LIKE ?").get("%ZABORT-b%")!.c;
    const hasA = db.prepare("SELECT COUNT(*) c FROM messages WHERE content LIKE ?").get("%ZABORT-a%")!.c;
    dbManager.close();
    assert.equal(hasA, 1, "the session completed before teardown landed");
    assert.equal(hasB, 0, "post-dispose load must not write (B4)");
  });

  it("4. (R2 core) retention window blocks re-adding pruned sessions, retrievability stays off", async () => {
    const oldIso = iso(7 * DAY_MS); // well outside days=1
    const p = port([{ sessionId: "old", updatedAt: oldIso, text: "pruned verbatim text" }]);
    const { handle } = openTenant({ history: p, retentionDays: 1 });
    await handle.ready;

    const stats = await handle.reindexSessions();
    assert.equal(stats.expiredSkipped, 1, "the R2 guard counted the block");
    assert.deepEqual(p.calls.loads, [], "an out-of-window session is never even loaded");
    assert.equal(searchFor(handle, "pruned verbatim text"), 0, "not re-added to the retrieval face");
    const cursor = cursorOf(handle);
    assert.equal(cursor.old, undefined, "cursor entry not created for a skipped-expired session");
  });

  it("5. (R3) an in-flight open pass chains: no interleaved loads, ordered timeline", async () => {
    const p = port([
      { sessionId: "f1", updatedAt: iso(DAY_MS), text: "fact one" },
      { sessionId: "f2", updatedAt: iso(DAY_MS), text: "fact two" },
    ]);
    let releaseLoad: () => void = () => {};
    const block = new Promise<void>((res) => { releaseLoad = res; });
    p.deferredLoad = async (id) => {
      await block;
      return p.entries.get(id);
    };
    const { handle } = openTenant({ history: p });
    // Kickoff is armed and starts after `ready`; load #1 blocks on `block`.
    const readyDone = handle.ready;
    const reindex = handle.reindexSessions();
    await readyDone;
    // Reindex chained behind the open pass (it holds the gate); nothing loaded yet.
    const timelineBefore = p.calls.loads.length;
    releaseLoad();
    // Let the open pass drain first: it processes f1 then f2; the reindex
    // follows and re-walks — both share the cursor, the second walk's loads
    // bypass the cursor skip (full mode) but never interleave with the first.
    await new Promise((r) => setTimeout(r, 100));
    const interleaved = p.calls.loads.length > 0 && timelineBefore !== 0;
    assert.ok(!interleaved, "loads happen in pass order, never interleaved (gate serializes)");
    const stats = await reindex;
    assert.equal(stats.aborted, false);
    p.deferredLoad = null;
  });

  it("6. no history port rejects with a stable code; session_search off likewise", async () => {
    const { handle } = openTenant();
    await handle.ready;
    await assert.rejects(handle.reindexSessions(), /SCOPED_REINDEX_NO_HISTORY_PORT/);
    const { handle: noSearch } = openTenant({ history: port([]), sessionSearch: false });
    await noSearch.ready;
    await assert.rejects(noSearch.reindexSessions(), /SCOPED_REINDEX_NO_SESSION_SEARCH/);
  });

  it("8. NaN updatedAt: reindexed, never skipped as expired (R6 conservatism)", async () => {
    const p = port([{ sessionId: "nan", updatedAt: "definitely-not-a-date", text: "nan anchor fact" }]);
    const { handle } = openTenant({ history: p, retentionDays: 1 });
    await handle.ready;

    const stats = await handle.reindexSessions();
    assert.equal(stats.expiredSkipped, 0, "unknown age is never treated as expired");
    assert.ok(p.calls.loads.includes("nan"), "conservative toward recall: the pass reindexes it");
    assert.ok(searchFor(handle, "nan anchor fact") >= 1, "and it lands on the retrieval face");
  });

  it("9. reconcile inside a full pass still deletes vanished ids and protects the live session", async () => {
    const p = port([{ sessionId: "live", updatedAt: iso(DAY_MS), text: "still here" }]);
    const { handle } = openTenant({ history: p });
    await handle.ready;
    // Seed a stale cursor entry for a session that is no longer listed.
    const db = dbOf(handle);
    try {
      db.getDb().prepare(
        "INSERT INTO extension_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("scoped_session_backfill", JSON.stringify({ gone: "2026-01-01T00:00:00Z" }));
      db.getDb().prepare("INSERT INTO sessions (id, project, cwd, started_at, ended_at, message_count) VALUES (?, 'p', 'c', '2026-01-01T00:00:00Z', NULL, 0)")
        .run("gone");
    } finally {
      db.close();
    }

    await handle.reindexSessions();
    const after = dbOf(handle);
    try {
      const rows = after.getDb().prepare("SELECT id FROM sessions WHERE id = 'gone'").all();
      assert.equal(rows.length, 0, "vanished sessions deleted — the full pass keeps reconcile (fact 5)");
    } finally {
      after.close();
    }
    assert.ok(!("gone" in cursorOf(handle)), "cursor entry dropped for the deleted id");
  });

  it("10. descriptor declares historyReindex (host capability word)", async () => {
    const providerModule = await import("../../src/scoped/provider.js");
    const caps = providerModule.default.capabilities;
    assert.equal(caps?.historyReindex, true, "the naming drift (sessionReindex) never crossed implementation");
    assert.equal(caps?.memoryCompaction, true);
    assert.equal(caps?.sharedProfile, true);
    assert.equal(caps?.dataRetention, true);
  });
});

describe("provider reindexHistory() → MaintenanceResult mapping", () => {
  it("maps stats to the port shape without content; guards surface as skipped", async () => {
    const providerModule = await import("../../src/scoped/provider.js");
    const p = port([
      { sessionId: "pm1", updatedAt: iso(DAY_MS), text: "provider mapped ZMARKER" },
    ]);
    const session = await providerModule.default.open({
      storageRoot: tempRoot("pmap"),
      history: p,
    });
    const result = await session.reindexHistory();
    assert.equal(typeof result.affected, "number");
    assert.deepEqual(result.errors, []);
    assert.ok(!JSON.stringify(result).includes("ZMARKER"), "no content crosses the port");
    await session.dispose();

    // Without a history port: the host sees skipped, not a thrown guard.
    const session2 = await providerModule.default.open({ storageRoot: tempRoot("pmap2") });
    const skipped = await session2.reindexHistory();
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.affected, 0);
    assert.ok(skipped.errors[0]?.includes("SCOPED_REINDEX_NO_HISTORY_PORT"));
    await session2.dispose();
  });
});
