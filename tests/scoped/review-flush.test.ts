import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupScopedReviewFlush } from "../../src/scoped/review-flush.js";
import type { MemoryCompletion } from "../../src/scoped/completion-types.js";
import { MemoryStore } from "../../src/store/memory-store.js";

/**
 * Scoped background review + flush, driven by the same injected completion.
 * Tests mount the handler on a fake pi, fire the real pi events, and assert
 * the completion was called (or deliberately not called) with a bounded plan.
 */

interface Handler { (event: any, ctx: any): Promise<void> | void }

function mount(): { pi: ExtensionAPI; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI;
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

const roots: string[] = [];
function tempStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-rf-"));
  roots.push(dir);
  return new MemoryStore({ memoryDir: dir });
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scoped review/flush via injected completion", () => {
  it("registers message_end, turn_end and session_shutdown", () => {
    const { pi, handlers } = mount();
    setupScopedReviewFlush(pi, { store: tempStore(), complete: async () => ({ text: "{}", ok: true }) });
    assert.ok(handlers.has("message_end"));
    assert.ok(handlers.has("turn_end"));
    assert.ok(handlers.has("session_shutdown"));
  });

  it("review fires after the turn threshold and applies an add", async () => {
    const { pi, handlers } = mount();
    const store = tempStore();
    let called = 0;
    const plan = JSON.stringify({ operations: [{ action: "add", target: "user", content: "prefers concise replies" }] });
    const complete: MemoryCompletion = async (req) => {
      called++;
      assert.match(req.systemPrompt, /review/i);
      return { text: plan, ok: true };
    };
    setupScopedReviewFlush(pi, { store, complete, reviewEveryTurns: 2 });

    for (let i = 0; i < 2; i++) {
      await handlers.get("message_end")!({ message: { role: "user" } }, ctx);
    }
    await handlers.get("turn_end")!({}, ctx);

    assert.equal(called, 1);
    assert.match(store.getUserEntries().join("\n"), /concise replies/);
  });

  it("review does not fire before the threshold", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, { store: tempStore(), complete, reviewEveryTurns: 3 });

    await handlers.get("message_end")!({ message: { role: "user" } }, ctx);
    await handlers.get("turn_end")!({}, ctx);

    assert.equal(called, 0);
  });

  it("in-flight guard prevents overlapping reviews", async () => {
    const { pi, handlers } = mount();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; await gate; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, { store: tempStore(), complete, reviewEveryTurns: 1 });

    await handlers.get("message_end")!({ message: { role: "user" } }, ctx);
    const first = handlers.get("turn_end")!({}, ctx);
    // While the first review is suspended, another turn must not start a second.
    await handlers.get("turn_end")!({}, ctx);
    release();
    await first;

    assert.equal(called, 1);
  });

  it("flush fires once at shutdown and applies a memory add", async () => {
    const { pi, handlers } = mount();
    const store = tempStore();
    let called = 0;
    const plan = JSON.stringify({ operations: [{ action: "add", target: "user", content: "flush saved preference" }] });
    const complete: MemoryCompletion = async (req) => {
      called++;
      assert.match(req.systemPrompt, /compress|session/i);
      return { text: plan, ok: true };
    };
    setupScopedReviewFlush(pi, { store, complete, reviewEveryTurns: 99 });

    await handlers.get("message_end")!({ message: { role: "user" } }, ctx);
    await handlers.get("session_shutdown")!({}, ctx);
    await handlers.get("session_shutdown")!({}, ctx); // idempotent

    assert.equal(called, 1);
    assert.match(store.getUserEntries().join("\n"), /flush saved preference/);
  });

  it("completion failure is swallowed — session handlers never throw", async () => {
    const { pi, handlers } = mount();
    const store = tempStore();
    const complete: MemoryCompletion = async () => ({ text: "", ok: false, error: "model down" });
    setupScopedReviewFlush(pi, { store, complete, reviewEveryTurns: 1 });

    await handlers.get("message_end")!({ message: { role: "user" } }, ctx);
    await handlers.get("turn_end")!({}, ctx); // must not reject
    await handlers.get("session_shutdown")!({}, ctx); // must not reject

    assert.match(store.getUserEntries().join("\n"), /^$/);
  });

  it("no completion call when the session branch is empty", async () => {
    const { pi, handlers } = mount();
    const emptyCtx = { sessionManager: { getBranch: () => [] } } as any;
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedReviewFlush(pi, { store: tempStore(), complete, reviewEveryTurns: 1 });

    await handlers.get("message_end")!({ message: { role: "user" } }, emptyCtx);
    await handlers.get("turn_end")!({}, emptyCtx);

    assert.equal(called, 0);
  });
});
