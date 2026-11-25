import { describe, it, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  openScopedHermesMemory,
  type ScopedHermesHandle,
} from "../../src/scoped/entry.js";
import { DatabaseManager, DATABASE_CLOSED_MESSAGE } from "../../src/store/db.js";
import { reportScopedIndexFailure } from "../../src/scoped/session-search.js";

/**
 * session_search (backlog #3, current-session slice). Drives the tools and
 * handlers the way a host would — through `pi.registerTool` / `pi.on` — so a
 * wiring regression fails here even when store-level tests still pass.
 *
 * Design record: docs/fork/SESSION-SEARCH-DESIGN.md §7 (tests 1-11 map 1:1
 * to the `it` cases). Snapshots carry getHeader/getEntries and the §3.1
 * trap-shaped getSessionFile (present, returns undefined) — agent-chat's
 * SessionManager behaves exactly like that, so any accidental switch to
 * indexLiveSession makes test 2 find zero rows.
 */

interface CapturedTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (id: string, args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function fakePi(): {
  pi: ExtensionAPI;
  tools: Map<string, CapturedTool>;
  handlers: Map<string, Handler>;
} {
  const tools = new Map<string, CapturedTool>();
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      // entry + session-search can stack several handlers on one event;
      // keep the whole chain like a real runner would.
      const prev = handlers.get(event);
      handlers.set(event, prev
        ? async (e: unknown, c: unknown) => { await prev(e, c); await handler(e, c); }
        : handler);
    },
    registerTool(def: CapturedTool) {
      tools.set(def.name, def);
      return true;
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers };
}

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-sessearch-${label}-`));
  roots.push(dir);
  return dir;
}

function makeSnapshot(
  header: { id: string; timestamp: string; cwd: string } | null,
  entries: unknown[] | (() => never),
) {
  return {
    getHeader: () => header,
    getEntries: Array.isArray(entries) ? () => entries : entries,
    // The §3.1 trap shape: the method exists (real Pi class) but in-memory
    // sessions have no file, so it returns undefined.
    getSessionFile: () => undefined,
  } as any;
}

function turnCtx(snapshot: unknown) {
  return { sessionManager: snapshot } as any;
}

function messageEntry(id: string, role: "user" | "assistant", text: string, timestamp: string) {
  return { type: "message", id, timestamp, message: { role, content: text } };
}

const HEADER = { id: "sess-1", timestamp: "2026-11-25T09:00:00Z", cwd: "/work/alpha" };

function mountTenant(options: { root: string; sessionSearch?: boolean }) {
  const fake = fakePi();
  const handle = openScopedHermesMemory({
    storageRoot: options.root,
    ...(options.sessionSearch === undefined
      ? {}
      : { tuning: { sessionSearch: options.sessionSearch } }),
  });
  handles.push(handle);
  handle.mount(fake.pi);
  return { handle, ...fake };
}

async function fireTurnEnd(handlers: Map<string, Handler>, snapshot: unknown) {
  await handlers.get("turn_end")!({ toolResults: [] }, turnCtx(snapshot));
}

function toolText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((c) => c.text).join("\n");
}

/** Open a SECOND read-only handle on the tenant's mirror for count asserts. */
function statsOf(handle: ScopedHermesHandle) {
  const probe = new DatabaseManager(handle.layout.memoryDir);
  try {
    return probe.getStats();
  } finally {
    probe.close();
  }
}

async function flushMicrotasks() {
  await new Promise((resolve) => setImmediate(resolve));
}

// console.error capture for the failure-observability tests. Swapped per-run,
// restored in afterEach.
let originalConsoleError: typeof console.error | null = null;
let capturedErrors: unknown[][] = [];
function captureConsole() {
  capturedErrors = [];
  if (!originalConsoleError) {
    originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { capturedErrors.push(args); };
  }
}
function releaseConsole() {
  if (originalConsoleError) {
    console.error = originalConsoleError;
    originalConsoleError = null;
  }
}

beforeEach(() => captureConsole());
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  releaseConsole();
  for (const dir of roots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows: a stray handle can hold the WAL a beat longer; the next
      // run's temp dir differs, so a failed cleanup is noise, not failure.
    }
  }
});

describe("session_search: mount + policy flag (§7 tests 1, 8)", () => {
  it("test 1+8: opt-out registers nothing and the prompt omits the sentence; default mounts both", async () => {
    const off = mountTenant({ root: tempRoot("off"), sessionSearch: false });
    await off.handle.ready;
    assert.ok(off.tools.has("memory_search"), "existing tools must still mount");
    assert.ok(!off.tools.has("session_search"), "session_search must not register when opted out");
    // No `complete` is injected here, so review/flush/correction mount nothing
    // on turn_end either — the ONLY turn_end source is the index listener, and
    // opting out must remove it entirely (not just the tool).
    assert.ok(!off.handlers.has("turn_end"), "no index listeners without the tool");
    assert.ok(!off.handlers.has("session_shutdown"));
    const offPrompt = await off.handle.promptSection();
    assert.ok(!offPrompt.includes("session_search"),
      "policy must not claim a tool that is not mounted");

    const on = mountTenant({ root: tempRoot("on-default") });
    await on.handle.ready;
    assert.ok(on.tools.has("session_search"), "omitted tuning mounts the tool (host path)");
    assert.ok(on.handlers.has("turn_end"));
    assert.ok(on.handlers.has("session_shutdown"));
    const onPrompt = await on.handle.promptSection();
    assert.match(onPrompt, /Use session_search to look up an earlier conversation verbatim/);
  });
});

describe("session_search: index then search (§7 tests 2-5)", () => {
  it("test 2: turn_end indexes, tool search finds the assistant wording verbatim", async () => {
    const { handle, tools, handlers } = mountTenant({ root: tempRoot("index") });
    await handle.ready;
    const snapshot = makeSnapshot(HEADER, [
      messageEntry("m1", "user", "我们上次讨论的 migration 顺序是什么", "2026-11-25T09:01:00Z"),
      messageEntry("m2", "assistant", "先跑 schema 迁移再回填数据,按租户逐个执行", "2026-11-25T09:02:00Z"),
    ]);
    await fireTurnEnd(handlers, snapshot);

    const result = await tools.get("session_search")!.execute("tc", { query: "回填数据" });
    assert.equal(result.details.count, 1);
    const text = toolText(result);
    assert.match(text, /回填数据/);
    assert.match(text, /🤖 Assistant/);
    // role/date come from the row; role filter works on the same table.
    const userOnly = await tools.get("session_search")!.execute("tc", { query: "migration", role: "user" });
    assert.equal(userOnly.details.count, 1);
    const assistantOnly = await tools.get("session_search")!.execute("tc", { query: "migration", role: "assistant" });
    assert.equal(assistantOnly.details.count, 0);
  });

  it("test 3: the same turn_end twice stays idempotent", async () => {
    const { handle, tools, handlers } = mountTenant({ root: tempRoot("idem") });
    await handle.ready;
    const snapshot = makeSnapshot(HEADER, [
      messageEntry("m1", "user", "a unique sentence appears exactly once", "2026-11-25T09:01:00Z"),
    ]);
    await fireTurnEnd(handlers, snapshot);
    const first = statsOf(handle).messages;
    await fireTurnEnd(handlers, snapshot);
    const second = statsOf(handle).messages;

    assert.equal(first, 1, "one message row after the first index");
    assert.equal(second, 1, "re-indexing the same entries must not add rows");
    const result = await tools.get("session_search")!.execute("tc", { query: "unique sentence" });
    assert.equal(result.details.count, 1, "no duplicate hits");
  });

  it("test 4: appending an entry indexes only the new message", async () => {
    const { handle, tools, handlers } = mountTenant({ root: tempRoot("incr") });
    await handle.ready;
    const entries = [
      messageEntry("m1", "user", "first fact about quotas", "2026-11-25T09:01:00Z"),
    ];
    const snapshot = makeSnapshot(HEADER, entries);
    await fireTurnEnd(handlers, snapshot);
    assert.equal(statsOf(handle).messages, 1);

    entries.push(messageEntry("m2", "assistant", "second fact about rate limits", "2026-11-25T09:03:00Z"));
    await fireTurnEnd(handlers, snapshot);
    assert.equal(statsOf(handle).messages, 2, "only the appended entry is added");

    assert.equal((await tools.get("session_search")!.execute("tc", { query: "rate limits" })).details.count, 1);
    assert.equal((await tools.get("session_search")!.execute("tc", { query: "quotas" })).details.count, 1);
  });

  it("test 5: session_shutdown flushes an entry appended after the last turn_end", async () => {
    const { handle, tools, handlers } = mountTenant({ root: tempRoot("flush") });
    await handle.ready;
    const entries = [messageEntry("m1", "user", "early turn content", "2026-11-25T09:01:00Z")];
    const snapshot = makeSnapshot(HEADER, entries);
    await fireTurnEnd(handlers, snapshot);
    entries.push(messageEntry("m2", "assistant", "late arrival tail detail", "2026-11-25T09:09:00Z"));
    // No second turn_end — only the shutdown handler runs.
    await handlers.get("session_shutdown")!({}, turnCtx(snapshot));

    const result = await tools.get("session_search")!.execute("tc", { query: "tail detail" });
    assert.equal(result.details.count, 1, "shutdown must index what turn_end missed");
  });
});

describe("session_search: isolation + best-effort (§7 tests 6, 7, 11)", () => {
  it("test 6: two tenants never see each other's messages", async () => {
    const a = mountTenant({ root: tempRoot("ta") });
    const b = mountTenant({ root: tempRoot("tb") });
    await a.handle.ready;
    await b.handle.ready;

    const sharedQuery = "cross tenant leak probe";
    await fireTurnEnd(a.handlers, makeSnapshot(
      { id: "sa", timestamp: HEADER.timestamp, cwd: "/work/alpha" },
      [messageEntry("x1", "user", `${sharedQuery} tenant A only`, "2026-11-25T09:01:00Z")],
    ));
    await fireTurnEnd(b.handlers, makeSnapshot(
      { id: "sb", timestamp: HEADER.timestamp, cwd: "/work/beta" },
      [messageEntry("y1", "user", "beta keeps its own business", "2026-11-25T09:02:00Z")],
    ));

    const inA = await a.tools.get("session_search")!.execute("tc", { query: sharedQuery });
    assert.equal(inA.details.count, 1);
    const inB = await b.tools.get("session_search")!.execute("tc", { query: sharedQuery });
    assert.equal(inB.details.count, 0, "tenant B's mirror must not hold A's rows");
    assert.equal(statsOf(b.handle).messages, 1, "B indexed only its own message");
  });

  it("test 7: best-effort paths resolve — null header, empty session, no propagation", async () => {
    const { handle, handlers } = mountTenant({ root: tempRoot("best") });
    await handle.ready;

    // getHeader() → null (session not started yet / restored without header).
    await fireTurnEnd(handlers, makeSnapshot(null, []));
    // Empty entries: indexCurrentSession may return an IndexResult with 0 rows.
    await fireTurnEnd(handlers, makeSnapshot(HEADER, []));
    // No throw, no noise.
    assert.equal(statsOf(handle).messages, 0, "nothing was indexable");
    assert.equal(capturedErrors.length, 0, "best-effort no-ops must not be reported");
  });

  it("test 7b: the closed-DB error class is skipped as teardown noise, others are reported", () => {
    reportScopedIndexFailure(new Error(DATABASE_CLOSED_MESSAGE));
    assert.equal(capturedErrors.length, 0, "closed DB is noise, not a failure");
    reportScopedIndexFailure(new Error("disk on fire"));
    return flushMicrotasks().then(() => {
      assert.equal(capturedErrors.length, 1, "a real failure must be observable");
      assert.match(String(capturedErrors[0][0]), /session index failed/);
    });
  });

  it("test 11: a throwing snapshot surfaces via console.error and never breaks the turn", async () => {
    const { handle, handlers } = mountTenant({ root: tempRoot("fail") });
    await handle.ready;
    const boom = makeSnapshot(HEADER, (() => { throw new Error("boom from pi"); }) as () => never);

    await fireTurnEnd(handlers, boom); // must resolve, not reject
    await handlers.get("session_shutdown")!({}, turnCtx(boom));
    await flushMicrotasks();

    const messages = capturedErrors.filter((args) => String(args[0]).includes("session index failed"));
    assert.equal(messages.length, 2, "both handlers must report the real failure");
  });
});

describe("session_search: tool surface (§7 tests 9, 10)", () => {
  it("test 10: wording promises only this session — no past-sessions or slash-command claims", async () => {
    const { handle, tools } = mountTenant({ root: tempRoot("wording") });
    await handle.ready;
    const tool = tools.get("session_search")!;

    const prose = [
      tool.description ?? "",
      tool.promptSnippet ?? "",
      ...(tool.promptGuidelines ?? []),
    ].join("\n");

    const forbidden: RegExp[] = [
      /past (Pi )?(coding )?sessions/i,
      /last week/i,
      /\bearlier sessions\b/i,
      /previous discussions/i,
      /memory-index-sessions/,
    ];
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(prose), `tool prose must not claim "${pattern}"`);
    }
    // Positive pin: the scoped promise has to actually appear.
    assert.match(prose, /current session/i);

    // Empty-index path must not name a command either.
    const empty = await tool.execute("tc", { query: "anything" });
    assert.match(toolText(empty), /indexed automatically as each turn ends/i);
    assert.ok(!toolText(empty).includes("/memory"), "no slash-command guidance in results");
  });

  it("test 9: importing the scoped module reads no env/home and touches no PI_CODING_AGENT_DIR", () => {
    const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-sentinel-"));
    roots.push(sentinel);
    const modulePath = path.resolve("src/scoped/session-search.ts");
    const childScript = path.join(sentinel, "probe.mts");
    fs.writeFileSync(
      childScript,
      [
        `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(sentinel)};`,
        `await import(${JSON.stringify(pathToFileURL(modulePath).href)});`,
        `console.log("IMPORTED_CLEAN");`,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", childScript], {
      encoding: "utf-8",
      env: { ...process.env, PI_CODING_AGENT_DIR: sentinel },
    });
    assert.equal(result.status, 0, `child import failed: ${result.stderr}`);
    assert.match(result.stdout, /IMPORTED_CLEAN/);
    const leftovers = fs.readdirSync(sentinel).filter((name) => name !== "probe.mts");
    assert.deepEqual(leftovers, [],
      `import must not create files under the agent dir: ${leftovers.join(", ")}`);
  });
});
