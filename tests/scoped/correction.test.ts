import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupScopedCorrectionDetector } from "../../src/scoped/correction.js";
import { createBackgroundGate, type BackgroundGate } from "../../src/scoped/background-gate.js";
import type { MemoryCompletion } from "../../src/scoped/completion-types.js";
import { MemoryStore } from "../../src/store/memory-store.js";
import { defaultMemoryConfig } from "../../src/config.js";

/**
 * Scoped correction detection via the injected completion. Tests mount the
 * handler on a fake pi, fire the real events, and assert the correction was
 * saved through completion (no subprocess, no UI notify, no project target)
 * and that it shares the background gate with review/flush.
 */

interface Handler { (event: any, ctx: any): Promise<void> | void }

function mount(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler>;
  notifyCalls: unknown[];
} {
  const handlers = new Map<string, Handler>();
  const notifyCalls: unknown[] = [];
  const pi = {
    on(event: string, handler: Handler) { handlers.set(event, handler); },
    ui: { notify: (...args: unknown[]) => notifyCalls.push(args) },
  } as unknown as ExtensionAPI;
  return { pi, handlers, notifyCalls };
}

function branch(texts: Array<[string, string]>): any[] {
  return texts.map(([role, content]) => ({ type: "message", message: { role, content } }));
}

const conversation = branch([
  ["user", "use pnpm please"],
  ["assistant", "I used npm, sorry"],
  ["user", "no, use pnpm instead"],
]);
const ctx = { sessionManager: { getBranch: () => conversation }, signal: undefined } as any;

const roots: string[] = [];
function tempStore(): MemoryStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-cor-"));
  roots.push(dir);
  return new MemoryStore({ memoryDir: dir });
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function opts(store: MemoryStore, complete: MemoryCompletion, extra: Record<string, unknown> = {}) {
  return { store, complete, config: defaultMemoryConfig(), ...extra };
}

describe("scoped correction detection via injected completion", () => {
  it("registers message_end and turn_end only (no shutdown)", () => {
    const { pi, handlers } = mount();
    setupScopedCorrectionDetector(pi, opts(tempStore(), async () => ({ text: "{}", ok: true })));
    assert.ok(handlers.has("message_end"));
    assert.ok(handlers.has("turn_end"));
    assert.ok(!handlers.has("session_shutdown"));
  });

  it("detects a strong correction and applies an add through completion", async () => {
    const { pi, handlers, notifyCalls } = mount();
    const store = tempStore();
    let called = 0;
    const plan = JSON.stringify({ operations: [{ action: "add", target: "memory", content: "always use pnpm" }] });
    const complete: MemoryCompletion = async (req) => {
      called++;
      assert.match(req.systemPrompt, /corrected the agent/i);
      assert.match(req.userPrompt, /use pnpm instead/);
      return { text: plan, ok: true };
    };
    setupScopedCorrectionDetector(pi, opts(store, complete));

    await handlers.get("message_end")!({ message: { role: "user", content: "no, use pnpm instead" } }, ctx);
    await handlers.get("turn_end")!({}, ctx);

    assert.equal(called, 1);
    assert.match(store.getMemoryEntries().join("\n"), /always use pnpm/);
    // UI notification is deliberately dropped in the scoped host.
    assert.equal(notifyCalls.length, 0);
  });

  it("captures the correction as a failure memory for learning", async () => {
    const { pi, handlers } = mount();
    const store = tempStore();
    const complete: MemoryCompletion = async () => ({ text: "{}", ok: true });
    setupScopedCorrectionDetector(pi, opts(store, complete));

    await handlers.get("message_end")!({ message: { role: "user", content: "don't do that" } }, ctx);
    await handlers.get("turn_end")!({}, ctx);

    assert.match(store.getFailureEntries().join("\n"), /do that/);
  });

  it("ignores non-corrections and negative patterns", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedCorrectionDetector(pi, opts(tempStore(), complete));

    for (const text of ["no worries, I'll handle it", "yes, do that", "no just kidding"]) {
      await handlers.get("message_end")!({ message: { role: "user", content: text } }, ctx);
      await handlers.get("turn_end")!({}, ctx);
    }

    assert.equal(called, 0);
  });

  it("rate-limits to one save per minTurns", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedCorrectionDetector(pi, opts(tempStore(), complete, { minTurnsBetween: 3 }));

    for (let i = 0; i < 2; i++) {
      await handlers.get("message_end")!({ message: { role: "user", content: "don't do that" } }, ctx);
      await handlers.get("turn_end")!({}, ctx);
    }

    assert.equal(called, 1);
  });

  it("completion failure is swallowed — handlers never throw", async () => {
    const { pi, handlers } = mount();
    const complete: MemoryCompletion = async () => ({ text: "", ok: false, error: "model down" });
    setupScopedCorrectionDetector(pi, opts(tempStore(), complete));

    await handlers.get("message_end")!({ message: { role: "user", content: "don't do that" } }, ctx);
    await handlers.get("turn_end")!({}, ctx); // must not reject
  });

  it("is a no-op when correctionDetection is disabled", async () => {
    const { pi, handlers } = mount();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    const config = { ...defaultMemoryConfig(), correctionDetection: false };
    setupScopedCorrectionDetector(pi, { store: tempStore(), complete, config });

    assert.equal(handlers.size, 0);
    assert.equal(called, 0);
  });

  it("shares the gate — skips a turn when review/flush holds the slot", async () => {
    const { pi, handlers } = mount();
    const store = tempStore();
    const gate: BackgroundGate = createBackgroundGate();
    let called = 0;
    const complete: MemoryCompletion = async () => { called++; return { text: "{}", ok: true }; };
    setupScopedCorrectionDetector(pi, opts(store, complete, { gate }));

    // Someone else owns the slot this turn.
    assert.equal(gate.tryStart(), true);
    await handlers.get("message_end")!({ message: { role: "user", content: "don't do that" } }, ctx);
    await handlers.get("turn_end")!({}, ctx);
    assert.equal(called, 0);
    gate.finish();

    // Next turn: correction should now run (pending was kept).
    await handlers.get("turn_end")!({}, ctx);
    assert.equal(called, 1);
  });
});
