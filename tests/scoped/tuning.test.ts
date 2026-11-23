import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupScopedReviewFlush } from "../../src/scoped/review-flush.js";
import { openScopedHermesMemory, type ScopedHermesHandle } from "../../src/scoped/entry.js";
import type { MemoryCompletion } from "../../src/scoped/completion-types.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { defaultMemoryConfig } from "../../src/config.js";

/**
 * P4 tuning: review thresholds come from `MemoryConfig`, not copied literals,
 * and the two additive knobs (`nudgeMode`, `minUserTurnsBeforeReview`) travel
 * through an explicit mount call rather than the config object.
 *
 * Design record: docs/fork/P4-TUNING-DESIGN.md §7.
 */

interface Handler { (event: any, ctx: any): Promise<void> | void }

function mount(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const pi = { on(event: string, handler: Handler) { handlers.set(event, handler); } } as unknown as ExtensionAPI;
  return { pi, handlers };
}

function branch(turns: number): any[] {
  const out: any[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ type: "message", message: { role: "user", content: `user message ${i}` } });
    out.push({ type: "message", message: { role: "assistant", content: `assistant reply ${i}` } });
  }
  return out;
}

const ctx = { sessionManager: { getBranch: () => branch(5) } } as any;

async function feed(
  handlers: Map<string, Handler>,
  users: number,
  turns: number,
  toolResultsPerTurn = 0,
): Promise<void> {
  for (let i = 0; i < users; i++) {
    await handlers.get("message_end")!({ message: { role: "user", content: `u${i}` } }, ctx);
  }
  for (let i = 0; i < turns; i++) {
    const toolResults = Array.from({ length: toolResultsPerTurn }, (_, j) => ({ role: "toolResult", toolCallId: `${i}-${j}` }));
    await handlers.get("turn_end")!({ toolResults }, ctx);
  }
}

const roots: string[] = [];
function tempStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tuning-"));
  roots.push(dir);
  return new MemoryStore({ memoryDir: dir });
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Config with the given overrides, everything else upstream defaults. */
function cfg(overrides: Record<string, unknown> = {}) {
  return { ...defaultMemoryConfig(), ...overrides };
}

describe("P4: thresholds are read from config, not restated", () => {
  it("uses config.nudgeInterval, not a scoped literal", async () => {
    // A hardcoded 6 would need 6 turns; this asserts 2 is honoured.
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 2 }), nudgeMode: "turn",
      minUserTurnsBeforeReview: 0,
    });

    await feed(handlers, 0, 1);
    assert.equal(called, 0, "must not fire at 1 turn with nudgeInterval=2");
    await feed(handlers, 0, 1);
    assert.equal(called, 1, "must fire at 2 turns");
  });

  it("honours reviewEnabled: false", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ reviewEnabled: false, nudgeInterval: 1 }),
      nudgeMode: "turn", minUserTurnsBeforeReview: 0,
    });

    await feed(handlers, 0, 5);
    await handlers.get("session_shutdown")!({}, ctx);

    assert.equal(called, 0, "a switch the host sets must actually stop the work");
  });

  it("bounds the prompt by config.reviewRecentMessages", async () => {
    const { pi, handlers } = mount();
    let prompt = "";
    const complete: MemoryCompletion = async (req) => { prompt = req.userPrompt; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 1, reviewRecentMessages: 2 }),
      nudgeMode: "turn", minUserTurnsBeforeReview: 0,
    });

    await feed(handlers, 0, 1);

    // branch(5) has 10 messages; a limit of 2 must keep only the last two.
    const userLines = prompt.split("\n").filter((l) => l.startsWith("[USER]"));
    assert.equal(userLines.length, 1, `expected 1 recent [USER] line, got ${userLines.length}`);
  });

  it("explicit option beats config", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 99 }), reviewEveryTurns: 1,
      nudgeMode: "turn", minUserTurnsBeforeReview: 0,
    });

    await feed(handlers, 0, 1);
    assert.equal(called, 1, "the explicit reviewEveryTurns must win over config.nudgeInterval");
  });
});

describe("P4: nudgeMode", () => {
  it('"turn" ignores tool calls', async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 5, nudgeToolCalls: 2 }),
      nudgeMode: "turn", minUserTurnsBeforeReview: 0,
    });

    await feed(handlers, 0, 1, 10); // 10 tool calls, but only 1 turn
    assert.equal(called, 0, "under turn mode, tool calls alone must not trigger");
  });

  it('"tool" triggers on tool calls alone', async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 99, nudgeToolCalls: 2 }),
      nudgeMode: "tool", minUserTurnsBeforeReview: 0,
    });

    await feed(handlers, 0, 1, 3); // 3 tool calls, 1 turn
    assert.equal(called, 1);
  });

  it('"either" (default) triggers on whichever comes first', async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 99, nudgeToolCalls: 2 }),
      minUserTurnsBeforeReview: 0,
    }); // nudgeMode omitted → default "either"

    await feed(handlers, 0, 1, 3);
    assert.equal(called, 1, "either must fire on the tool threshold");
  });
});

describe("P4: minUserTurnsBeforeReview restores the lost guard", () => {
  it("a tool-heavy turn with one user message does not review; three messages do", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeToolCalls: 2 }), nudgeMode: "either",
      minUserTurnsBeforeReview: 3,
    });

    // One user sentence, plenty of tool calls: the guard must hold.
    await feed(handlers, 1, 1, 15);
    assert.equal(called, 0, "one user message must not be enough even with 15 tool calls");

    // Reach the third user message, then a qualifying turn.
    await feed(handlers, 2, 0);
    await feed(handlers, 0, 1, 15);
    assert.equal(called, 1);
  });

  it("defaults to 3 like upstream", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, {
      store: tempStore(), complete, config: cfg({ nudgeInterval: 1 }), nudgeMode: "turn",
    }); // minUserTurnsBeforeReview omitted → 3

    await feed(handlers, 2, 3);
    assert.equal(called, 0, "two user messages must not pass the default guard");

    await feed(handlers, 1, 1);
    assert.equal(called, 1);
  });
});

describe("P4: Chain B is wired through the entry mount", () => {
  const handles: ScopedHermesHandle[] = [];
  afterEach(async () => {
    for (const h of handles.splice(0)) await h.dispose();
  });

  it("applies tuning.nudgeMode through openScopedHermesMemory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-tuning-entry-"));
    roots.push(root);

    // Capture every handler the entry registers.
    const handlers = new Map<string, Handler>();
    const pi = {
      on(event: string, handler: Handler) {
        const prev = handlers.get(event);
        handlers.set(event, prev
          ? async (e: any, c: any) => { await prev(e, c); await handler(e, c); }
          : handler);
      },
      registerTool() { return true; },
    } as unknown as ExtensionAPI;

    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    const handle = openScopedHermesMemory({
      storageRoot: root,
      complete,
      // Chain B: these two are NOT MemoryConfig fields. If the entry forgets to
      // pass them to setupScopedReviewFlush, this test fails.
      tuning: { nudgeMode: "tool", minUserTurnsBeforeReview: 0, nudgeToolCalls: 2, reviewEveryTurns: 99 },
    });
    handles.push(handle);
    handle.mount(pi);
    await handle.ready;

    // 1 turn, 3 tool calls: only "tool" mode can fire here (turns 1 << 99).
    await handlers.get("turn_end")!({ toolResults: [{ role: "toolResult" }, { role: "toolResult" }, { role: "toolResult" }] }, ctx);

    assert.equal(called, 1, "tuning.nudgeMode must reach the handler through the entry mount");
  });
});