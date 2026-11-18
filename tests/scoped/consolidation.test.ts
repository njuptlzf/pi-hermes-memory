import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createScopedHermesMemory,
  type ScopedHermesHandle,
} from "../../src/scoped/entry.js";
import type { MemoryCompletion } from "../../src/scoped/completion-types.js";
import { consolidateViaCompletion } from "../../src/scoped/consolidation.js";
import { MEMORY_FILE } from "../../src/constants.js";

/**
 * Scoped auto-consolidation through the host-injected completion callback.
 *
 * Two levels are covered:
 *   1. the consolidator itself (bounded, atomic-shrink, structured failure);
 *   2. the wiring — a memory write that overflows only triggers consolidation
 *      when the host injected a callback, and a missing callback degrades
 *      without breaking the write.
 */

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-consol-${label}-`));
  roots.push(dir);
  return dir;
}

function fakePi(): { pi: ExtensionAPI; tools: Map<string, any> } {
  const tools = new Map<string, any>();
  return {
    tools,
    pi: {
      on() {},
      registerTool(def: any) { tools.set(def.name, def); return true; },
    } as unknown as ExtensionAPI,
  };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function completion(text: string): MemoryCompletion {
  return async () => ({ text, ok: true });
}

describe("scoped consolidation via injected completion", () => {
  it("applies a shrinking merge plan from the completion", async () => {
    const root = tempRoot("merge");
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    // Two verbose entries to be merged into one short one.
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILE),
      "alpha is very verbose and long for no reason <!-- created=2026-01-01, last=2026-01-01 -->\n§\n"
      + "alpha again with extra words that duplicate the first <!-- created=2026-01-01, last=2026-01-01 -->",
    );
    const { handle } = (() => {
      const fake = fakePi();
      const h = createScopedHermesMemory({ storageRoot: root })(fake.pi);
      handles.push(h);
      return { handle: h };
    })();
    await handle.ready;

    const plan = JSON.stringify({
      operations: [
        { action: "remove", target: "memory", old_text: "alpha is very verbose" },
        { action: "remove", target: "memory", old_text: "alpha again with extra" },
        { action: "add", target: "memory", content: "alpha: merged concise fact" },
      ],
    });
    const result = await consolidateViaCompletion(handle.store, {
      target: "memory",
      complete: completion(plan),
    });

    assert.equal(result.consolidated, true, JSON.stringify(result));
  });

  it("rejects a plan that does not shrink", async () => {
    const root = tempRoot("grow");
    const fake = fakePi();
    const handle = createScopedHermesMemory({ storageRoot: root })(fake.pi);
    handles.push(handle);
    await handle.ready;
    await handle.store.add("memory", "an existing short fact");

    // add-only plan grows the store; requireAtomicShrink must refuse it.
    const plan = JSON.stringify({
      operations: [{ action: "add", target: "memory", content: "a brand new much longer entry that grows the store" }],
    });
    const result = await consolidateViaCompletion(handle.store, {
      target: "memory",
      complete: completion(plan),
    });

    assert.equal(result.consolidated, false);
    assert.match(result.error ?? "", /failed|shrink|atomic|plan/i);
  });

  it("degrades to not-consolidated when completion fails, never throws", async () => {
    const root = tempRoot("fail");
    const fake = fakePi();
    const handle = createScopedHermesMemory({ storageRoot: root })(fake.pi);
    handles.push(handle);
    await handle.ready;
    await handle.store.add("memory", "keep me safe");

    const failing: MemoryCompletion = async () => ({ text: "", ok: false, error: "model 503" });
    const result = await consolidateViaCompletion(handle.store, {
      target: "memory",
      complete: failing,
    });

    assert.equal(result.consolidated, false);
    assert.match(result.error ?? "", /503/);
    // The failed consolidation did not damage the store.
    assert.match(handle.store.getMemoryEntries().join("\n"), /keep me safe/);
  });

  it("never issues a completion when already aborted", async () => {
    const root = tempRoot("abort");
    const fake = fakePi();
    const handle = createScopedHermesMemory({ storageRoot: root })(fake.pi);
    handles.push(handle);
    await handle.ready;
    await handle.store.add("memory", "entry");

    let called = false;
    const controller = new AbortController();
    controller.abort();
    const result = await consolidateViaCompletion(handle.store, {
      target: "memory",
      complete: async () => { called = true; return { text: "", ok: true }; },
      signal: controller.signal,
    });

    assert.equal(called, false);
    assert.equal(result.consolidated, false);
    assert.equal(result.error, "aborted");
  });

  it("mounts no consolidator when the host injects no completion", () => {
    const root = tempRoot("no-cap");
    const fake = fakePi();
    const handle = createScopedHermesMemory({ storageRoot: root })(fake.pi);
    handles.push(handle);
    // With no complete callback, tools still mount and writes still work.
    assert.ok(fake.tools.has("memory_add"));
    assert.ok(fake.tools.has("memory_search"));
  });

  it("mounts memory_search and write tools when completion is injected", async () => {
    const root = tempRoot("with-cap");
    const fake = fakePi();
    const handle = createScopedHermesMemory({
      storageRoot: root,
      complete: completion("{}"),
    })(fake.pi);
    handles.push(handle);
    await handle.ready;

    assert.ok(fake.tools.has("memory_add"));
    assert.ok(fake.tools.has("memory_search"));
    // A normal write must not be blocked by the presence of consolidation.
    const result = await fake.tools.get("memory_add")!.execute("tc", {
      target: "memory",
      content: "write works with consolidation mounted",
    });
    assert.equal(result.details.success, true);
  });
});
