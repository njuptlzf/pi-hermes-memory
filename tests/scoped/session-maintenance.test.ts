import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openScopedHermesMemory, type ScopedHermesHandle } from "../../src/scoped/entry.js";
import type { MemoryHistoryPort, MemorySessionSummary } from "../../src/scoped/history-types.js";
import { DatabaseManager } from "../../src/store/db.js";

/**
 * #4 session maintenance (P6-SESSION-MAINTENANCE-DESIGN.md).
 * D — recovery sidecars converge on open via the layered store facade;
 * A — retention prunes the tenant mirror without re-indexing pruned rows.
 * Both are entry-level behavioral tests on a real temp tenant DB.
 */

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-maint-${label}-`));
  roots.push(dir);
  return dir;
}

function openTenant(options: Parameters<typeof openScopedHermesMemory>[0]): ScopedHermesHandle {
  const handle = openScopedHermesMemory(options);
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A retired sidecar older than RETIRED_RECOVERY_MAX_AGE_MS (30d) is deleted by
 * `MemoryStore.pruneRecoveryFiles`. Without the ready-chain call in entry.ts,
 * nothing invokes it in the scoped path and the stale file survives — so this
 * assertion fails on the pre-fix tree and passes on the fixed tree.
 */
function seedStaleRetired(memoryDir: string): string {
  fs.mkdirSync(memoryDir, { recursive: true });
  const name = ".MEMORY.md.retired-1700000000000-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const full = path.join(memoryDir, name);
  fs.writeFileSync(full, "stale retired sidecar");
  const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
  fs.utimesSync(full, old, old);
  return full;
}

describe("#4 D — recovery sidecar maintenance on open (§7)", () => {
  it("1 — opening a tenant prunes stale retired sidecars in the scope root", async () => {
    const root = tempRoot("sidecar");
    const handle = openTenant({ storageRoot: root });
    const stale = seedStaleRetired(handle.layout.memoryDir);
    assert.ok(fs.existsSync(stale), "fixture: stale sidecar seeded");

    await handle.ready;

    assert.equal(fs.existsSync(stale), false, "stale retired sidecar must be pruned on open");
  });

  it("2 — sidecar pruning covers the shared profile root too", async () => {
    const root = tempRoot("shared-sidecar");
    const shared = tempRoot("shared-profile");
    const handle = openTenant({ storageRoot: root, sharedRoot: shared });
    const profileDir = handle.layout.profileDir;
    assert.ok(profileDir, "fixture: profile dir exists when sharedRoot given");
    const stale = seedStaleRetired(profileDir!);

    await handle.ready;

    assert.equal(fs.existsSync(stale), false, "profile sidecar must be pruned too");
  });

  it("3 — a throwing sidecar never fails open (best-effort)", async () => {
    const root = tempRoot("best-effort");
    const handle = openTenant({ storageRoot: root });
    // A directory where MEMORY.md should be makes canonicalMarkdownIdentity /
    // readdir hit an unexpected shape; open must still resolve ready.
    fs.mkdirSync(path.join(handle.layout.memoryDir, "MEMORY.md"), { recursive: true });
    await assert.doesNotReject(() => handle.ready);
  });
});

// ── A — retention prune ──────────────────────────────────────────────────

interface RetPort extends MemoryHistoryPort {
  sessions: MemorySessionSummary[];
  entries: Map<string, unknown[]>;
  loads: string[];
}

/** A port whose session headers carry controllable timestamps (→ started_at). */
function retentionPort(
  rows: Array<{ id: string; updatedAt: string; headerAt: string }>,
): RetPort {
  const entries = new Map<string, unknown[]>();
  for (const r of rows) {
    entries.set(r.id, [
      { type: "session", id: r.id, timestamp: r.headerAt, cwd: "/data/u1/alpha" },
      { type: "message", id: `${r.id}-m`, timestamp: r.headerAt,
        message: { role: "user", content: [{ type: "text", text: `${r.id} verbatim` }] } },
    ]);
  }
  return {
    sessions: rows.map((r) => ({ sessionId: r.id, updatedAt: r.updatedAt })),
    entries,
    loads: [],
    async list() { return this.sessions; },
    async load(id) { this.loads.push(id); return this.entries.get(id); },
  };
}

function sessionIds(handle: ScopedHermesHandle): string[] {
  const db = new DatabaseManager(handle.layout.memoryDir);
  try {
    return (db.getDb().prepare("SELECT id FROM sessions ORDER BY id").all() as Array<{ id: string }>)
      .map((r) => r.id);
  } finally { db.close(); }
}

async function remountWithRetention(
  root: string, history: MemoryHistoryPort | undefined, days: number | undefined,
): Promise<ScopedHermesHandle> {
  const prev = handles[handles.length - 1]!;
  await prev.dispose();
  handles.pop();
  const handle = openTenant({
    storageRoot: root, history,
    ...(days !== undefined ? { config: { sessionRetentionDays: days } } : {}),
  });
  return handle;
}

function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  const tick = (): Promise<void> => predicate()
    ? Promise.resolve()
    : Date.now() - started > timeoutMs
      ? Promise.reject(new Error("timed out"))
      : new Promise((r) => setTimeout(r, 10)).then(tick);
  return tick();
}

describe("#4 A — retention prune (§7)", () => {
  // `recent` must be computed from NOW, never a hardcoded calendar date: the
  // prune cutoff is Date.now()-based, so a literal like 2026-11-26 sits inside
  // a 1-day window only until the real clock passes it — a time-bomb that made
  // cases 5–8 fail in CI one day after PR #42 merged (2026-11-27). 6 hours old
  // is inside every retention window the cases use (1 day, and 3650 days for
  // the no-prune precedence assertion) and still a distinct session file.
  const rows = () => {
    const fresh = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    return [
      { id: "ancient", updatedAt: "2020-01-01T00:00:00Z", headerAt: "2020-01-01T00:00:00Z" },
      { id: "recent", updatedAt: fresh, headerAt: fresh },
    ];
  };

  it("4 — default (no retention config) keeps every session across re-open", async () => {
    const p = retentionPort(rows());
    const root = tempRoot("no-retention");
    let handle = openTenant({ storageRoot: root, history: p });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 2);

    handle = await remountWithRetention(root, p, undefined);
    await handle.ready;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(sessionIds(handle).sort(), ["ancient", "recent"]);
  });

  it("5 — retentionDays prunes old rows present from a prior open", async () => {
    const p = retentionPort(rows());
    const root = tempRoot("with-retention");
    let handle = openTenant({ storageRoot: root, history: p });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 2);
    assert.deepEqual(sessionIds(handle).sort(), ["ancient", "recent"], "fixture: both indexed");

    handle = await remountWithRetention(root, p, 1);
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 1);
    assert.deepEqual(sessionIds(handle), ["recent"], "old session must be pruned");
  });

  it("6 — a pruned-but-still-listed session is NOT re-indexed by backfill", async () => {
    const p = retentionPort(rows());
    const root = tempRoot("no-reindex");
    let handle = openTenant({ storageRoot: root, history: p });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 2);

    handle = await remountWithRetention(root, p, 1);
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 1);
    // The port STILL lists "ancient" with an unchanged updatedAt. A cursor
    // sentinel would make backfill reload it; the equality skip must hold.
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      sessionIds(handle), ["recent"],
      "pruned listed session must stay absent — a cursor sentinel would re-add it",
    );
  });

  // ── host policy channel (agent-chat PR #20-era MemoryPolicy) ──────────
  // The config-driven cases above prove the prune works; these prove the
  // HOST path reaches the same gate. Design: agent-chat
  // docs/design/记忆数据保留政策设计稿.md §3 (policy folds into
  // config.sessionRetentionDays, Chain A; policy > tuning > config spread).

  it("7 — ctx-level policy.dataRetentionDays drives the same prune as config", async () => {
    const p = retentionPort(rows());
    const root = tempRoot("policy-retention");
    let handle = openTenant({ storageRoot: root, history: p });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 2);

    // Re-open WITHOUT the legacy `config` shape — the policy field alone
    // must flip the gate. This is exactly what provider.open forwards.
    const prev = handle;
    await prev.dispose();
    handles.pop();
    handle = openTenant({ storageRoot: root, history: p, policy: { dataRetentionDays: 1 } });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 1);
    assert.deepEqual(sessionIds(handle), ["recent"], "policy must enable the prune on its own");
  });

  it("8 — policy wins over tuning.retentionDays; tuning alone still works", async () => {
    const p = retentionPort(rows());
    const root = tempRoot("policy-precedence");
    let handle = openTenant({ storageRoot: root, history: p });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 2);

    // Host says 3650 days, caller knob says 1: governance outranks the knob,
    // so nothing is pruned.
    const prev = handle;
    await prev.dispose();
    handles.pop();
    handle = openTenant({
      storageRoot: root, history: p,
      policy: { dataRetentionDays: 3650 },
      tuning: { retentionDays: 1 },
    });
    await handle.ready;
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(sessionIds(handle).sort(), ["ancient", "recent"], "policy must beat tuning");

    // Tuning alone (direct-user path) is a working fallback for the same gate.
    await handle.dispose();
    handles.pop();
    handle = openTenant({ storageRoot: root, history: p, tuning: { retentionDays: 1 } });
    await handle.ready;
    await waitFor(() => sessionIds(handle).length === 1);
    assert.deepEqual(sessionIds(handle), ["recent"], "tuning fallback must prune");
  });
});
