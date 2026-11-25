import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  openScopedHermesMemory,
  type ScopedHermesHandle,
} from "../../src/scoped/entry.js";
import type { MemoryHistoryPort, MemorySessionSummary } from "../../src/scoped/history-types.js";
import { DatabaseManager } from "../../src/store/db.js";

/**
 * Scoped history backfill (SESSION-BACKFILL-DESIGN.md §7). Entry-level tests:
 * a scripted port supplies exportHistory-shaped arrays, and assertions read
 * what session_search would see. The port is a structural shim — the fork
 * imports no host SDK.
 */

interface ScriptedPort extends MemoryHistoryPort {
  calls: { list: number; loads: string[] };
  sessions: MemorySessionSummary[];
  entries: Map<string, unknown[]>;
  failList?: boolean;
  deferredLoad?: (sessionId: string) => Promise<unknown[] | undefined>;
}

function port(sessions: Array<{ sessionId: string; updatedAt: string; text: string }>): ScriptedPort {
  const entries = new Map<string, unknown[]>();
  for (const s of sessions) {
    entries.set(s.sessionId, [
      { type: "session", id: s.sessionId, timestamp: "2026-11-20T09:00:00Z", cwd: "/data/u1/alpha" },
      { type: "message", id: `${s.sessionId}-m`, timestamp: "2026-11-20T09:01:00Z", message: { role: "assistant", content: [{ type: "text", text: s.text }] } },
    ]);
  }
  const scripts = {
    calls: { list: 0, loads: [] as string[] },
    sessions: sessions.map(({ sessionId, updatedAt }) => ({ sessionId, updatedAt })),
    entries,
    async list() {
      this.calls.list++;
      if (this.failList) throw new Error("history list down");
      return this.sessions;
    },
    async load(sessionId: string) {
      this.calls.loads.push(sessionId);
      if (this.deferredLoad) return this.deferredLoad(sessionId);
      return this.entries.get(sessionId);
    },
  };
  return scripts;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
function fakePi(): { pi: ExtensionAPI; tools: Map<string, any>; handlers: Map<string, Handler> } {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Handler>();
  return {
    tools,
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        const prev = handlers.get(event);
        handlers.set(event, prev
          ? async (e: unknown, c: unknown) => { await prev(e, c); await handler(e, c); }
          : handler);
      },
      registerTool(def: any) { tools.set(def.name, def); return true; },
    } as unknown as ExtensionAPI,
  };
}

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];
function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-backfill-${label}-`));
  roots.push(dir);
  return dir;
}

function mountTenant(history?: MemoryHistoryPort) {
  const fake = fakePi();
  const handle = openScopedHermesMemory({
    storageRoot: tempRoot("tenant"),
    history,
  });
  handles.push(handle);
  handle.mount(fake.pi);
  return { handle, ...fake };
}

/** Close the last handle and re-open the SAME tenant root (one handle per root). */
async function remount(history?: MemoryHistoryPort) {
  const previous = handles[handles.length - 1]!;
  const root = previous.roots.storageRoot;
  await previous.dispose();
  handles.pop();
  return mountOn(root, history);
}

function mountOn(root: string, history?: MemoryHistoryPort) {
  const fake = fakePi();
  const handle = openScopedHermesMemory({ storageRoot: root, history });
  handles.push(handle);
  handle.mount(fake.pi);
  return { handle, ...fake };
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for backfill");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function messagesOf(handle: ScopedHermesHandle): number {
  const db = dbOf(handle);
  try { return db.getStats().messages; } finally { db.close(); }
}

async function search(handleTools: Map<string, any>, query: string): Promise<string> {
  const result = await handleTools.get("session_search")!.execute("tc", { query });
  return result.content.map((c: { text: string }) => c.text).join("\n");
}

let originalConsoleError: typeof console.error | null = null;
let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  if (!originalConsoleError) {
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
  }
});
afterEach(async () => {
  for (const h of handles.splice(0)) await h.dispose();
  if (originalConsoleError) {
    console.error = originalConsoleError;
    originalConsoleError = null;
  }
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scoped history backfill (§7)", () => {
  it("1 — backfilled sessions are searchable; live indexing still works", async () => {
    const p = port([
      { sessionId: "old-a", updatedAt: "2026-11-20T10:00:00Z", text: "verbatim alpha decision" },
      { sessionId: "old-b", updatedAt: "2026-11-21T10:00:00Z", text: "verbatim beta decision" },
    ]);
    const { handle, tools, handlers } = mountTenant(p);
    await handle.ready;
    await waitFor(() => messagesOf(handle) === 2);

    assert.match(await search(tools, "alpha decision"), /verbatim alpha decision/);
    assert.match(await search(tools, "beta decision"), /verbatim beta decision/);

    // live path writes into the same mirror
    const snapshot = {
      getHeader: () => ({ id: "live", timestamp: "2026-11-25T09:00:00Z", cwd: "/data/u1/alpha" }),
      getEntries: () => [{
        type: "message", id: "live-m", timestamp: "2026-11-25T09:01:00Z",
        message: { role: "user", content: [{ type: "text", text: "live turn words" }] },
      }],
      getSessionFile: () => undefined,
    };
    await handlers.get("turn_end")!({}, { sessionManager: snapshot });
    assert.equal(messagesOf(handle), 3);
    assert.match(await search(tools, "live turn words"), /live turn words/);
  });

  it("2 — unchanged cursor skips loads on the next open", async () => {
    const p = port([{ sessionId: "s1", updatedAt: "2026-11-20T10:00:00Z", text: "cursor probe" }]);
    const first = mountTenant(p);
    await first.handle.ready;
    await waitFor(() => messagesOf(first.handle) === 1);
    const loadsAfterFirst = p.calls.loads.length;

    const second = await remount(p);
    await second.handle.ready;
    await waitFor(() => p.calls.list >= 2);
    assert.equal(p.calls.loads.length, loadsAfterFirst, "unchanged session must not be loaded twice");
    assert.equal(messagesOf(second.handle), 1);
  });

  it("3 — changed updatedAt reloads only that session", async () => {
    const p = port([
      { sessionId: "s1", updatedAt: "2026-11-20T10:00:00Z", text: "stable content" },
      { sessionId: "s2", updatedAt: "2026-11-20T10:00:00Z", text: "old wording" },
    ]);
    const { handle } = mountTenant(p);
    await handle.ready;
    await waitFor(() => messagesOf(handle) === 2);

    p.sessions[1] = { sessionId: "s2", updatedAt: "2026-11-21T10:00:00Z" };
    p.entries.set("s2", [
      { type: "session", id: "s2", timestamp: "2026-11-20T09:00:00Z", cwd: "/data/u1/alpha" },
      { type: "message", id: "s2-m1", timestamp: "2026-11-20T09:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "stable content" }] } },
      { type: "message", id: "s2-m2", timestamp: "2026-11-21T09:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "new wording" }] } },
    ]);
    p.calls.loads.length = 0;

    // Same root, fresh handle: s1's cursor unchanged → skipped, s2 reloaded.
    const second = await remount(p);
    await second.handle.ready;
    await waitFor(() => messagesOf(second.handle) === 4);
    assert.deepEqual(p.calls.loads, ["s2"], "only the changed session is loaded again");
  });

  it("4 — reconcile deletes sessions no longer in the authoritative set", async () => {
    const p = port([
      { sessionId: "keep", updatedAt: "2026-11-20T10:00:00Z", text: "zebra quartz kept" },
      { sessionId: "drop", updatedAt: "2026-11-20T10:00:00Z", text: "violin mango dropped" },
    ]);
    const { handle, tools } = mountTenant(p);
    await handle.ready;
    await waitFor(() => messagesOf(handle) === 2);

    p.sessions = p.sessions.filter((s) => s.sessionId === "keep");
    const second = await remount(p);
    await second.handle.ready;
    await waitFor(() => messagesOf(second.handle) === 1);

    assert.match(await search(second.tools, "zebra quartz"), /zebra quartz kept/);
    const dropped = await second.tools.get("session_search")!.execute("tc", { query: "violin mango" });
    assert.equal(dropped.details.count, 0, "the deleted session's message is gone from the mirror");
    assert.equal(cursorOf(second.handle)["drop"], undefined, "stale cursor pruned");
  });

  it("5 — the current live session is never deleted by reconcile", async () => {
    const p = port([{ sessionId: "resumed", updatedAt: "2026-11-20T10:00:00Z", text: "resumed words" }]);
    const { handle, handlers } = mountTenant(p);
    await handle.ready;
    await waitFor(() => messagesOf(handle) === 1);

    // Host dropped it from history, but it is the live session now.
    p.sessions = [];
    const snapshot = {
      getHeader: () => ({ id: "resumed", timestamp: "2026-11-25T09:00:00Z", cwd: "/data/u1/alpha" }),
      getEntries: () => [
        { type: "message", id: "resumed-live", timestamp: "2026-11-25T09:01:00Z", message: { role: "assistant", content: [{ type: "text", text: "live words" }] } },
      ],
    };
    await handlers.get("turn_end")!({}, { sessionManager: snapshot });
    assert.equal(messagesOf(handle), 2);

    await handle.dispose();
    handles.length = 0;
    const root = roots[0]!;
    const second = openScopedHermesMemory({ storageRoot: root, history: p });
    handles.push(second);
    await second.ready;
    await waitFor(() => Object.keys(cursorOf(second)).length === 0);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(messagesOf(second), 0, "on a fresh handle with no live session, reconcile deletes");
  });

  it("6 — budget: at most 50 sessions per open", async () => {
    const sessions = Array.from({ length: 60 }, (_, i) => ({
      sessionId: `s${String(i).padStart(2, "0")}`,
      updatedAt: "2026-11-20T10:00:00Z",
      text: `session number ${i}`,
    }));
    const p = port(sessions);
    const { handle } = mountTenant(p);
    await handle.ready;
    await waitFor(() => Object.keys(cursorOf(handle)).length === 50);
    assert.equal(Object.keys(cursorOf(handle)).length, 50);
    assert.equal(messagesOf(handle), 50, "the other 10 wait for the next open");
  });

  it("7 — no port: no cursor row, identical behavior to the current-session slice", async () => {
    const { handle, tools } = mountTenant();
    await handle.ready;
    assert.deepEqual(cursorOf(handle), {});
    const empty = await tools.get("session_search")!.execute("tc", { query: "anything" });
    assert.match(empty.content[0].text, /No messages indexed yet/);
  });

  it("8 — host faults degrade: list rejects, load returns undefined", async () => {
    const down = port([]);
    down.failList = true;
    const { handle, tools } = mountTenant(down);
    await handle.ready;
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(cursorOf(handle), {});
    assert.equal(tools.has("session_search"), true, "provider still mounts normally");
    await waitFor(() => errors.length > 0);
    assert.match(String(errors[0][0]), /session index failed/);

    const missing = port([{ sessionId: "gone", updatedAt: "2026-11-20T10:00:00Z", text: "x" }]);
    missing.deferredLoad = async () => undefined;
    const second = mountTenant(missing);
    await second.handle.ready;
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(cursorOf(second.handle)["gone"], undefined, "unreadable session never advances the cursor");
  });

  it("9 — dispose mid-backfill stops without closed-DB noise", async () => {
    let release!: (value: unknown[] | undefined) => void;
    const gate = new Promise<unknown[] | undefined>((resolve) => { release = resolve; });
    const p = port([{ sessionId: "slow", updatedAt: "2026-11-20T10:00:00Z", text: "slow content" }]);
    p.deferredLoad = () => gate as Promise<unknown[] | undefined>;
    const { handle } = mountTenant(p);
    await handle.ready;
    await waitFor(() => p.calls.loads.length === 1);
    await handle.dispose();
    handles.length = 0;
    release([{ type: "session", id: "slow", timestamp: "2026-11-20T09:00:00Z", cwd: "/data" }]);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(errors.length, 0, "closed-DB skip is silent");
  });

  it("10 — header-less entries: skipped, cursor advanced, no rows", async () => {
    const p = port([{ sessionId: "junk", updatedAt: "2026-11-20T10:00:00Z", text: "junk" }]);
    p.entries.set("junk", [{ type: "message", id: "m", message: { role: "user", content: "x" } }]);
    const { handle } = mountTenant(p);
    await handle.ready;
    await waitFor(() => cursorOf(handle)["junk"] !== undefined);
    assert.equal(messagesOf(handle), 0);
  });
});
