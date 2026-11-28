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
import { MEMORY_FILE } from "../../src/constants.js";

/**
 * Manual bounded compaction (backlog #12). Design: docs/fork/MEMORY-COMPACT-DESIGN.md §5.
 *
 * Nine cases: over-goal shrink, within-goal free no-op, no-completion skip,
 * gate deferral, the overflow-grace recovery loop, profile untouched, the
 * requireShrink rejection mapping, disposed abort, provider descriptor pin.
 */

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-compact-${label}-`));
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
  for (const handle of handles.splice(0)) await handle.dispose().catch(() => {});
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Counting completion stub; `plan` is the JSON payload every call returns. */
function completion(plan: unknown): { complete: MemoryCompletion; calls: () => number } {
  let n = 0;
  const text = typeof plan === "string" ? plan : JSON.stringify(plan);
  return {
    calls: () => n,
    complete: async () => { n++; return { text, ok: true }; },
  };
}

/** A tenant whose memory store sits above the goal, with two mergeable entries. */
function openOverGoal(label: string, stub: MemoryCompletion) {
  const root = tempRoot(label);
  const memoryDir = path.join(root, "memory");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, MEMORY_FILE),
    "alpha verbose duplicate one <!-- created=2026-01-01, last=2026-01-01 -->\n§\n"
    + "alpha verbose duplicate two <!-- created=2026-01-01, last=2026-01-01 -->",
  );
  const fake = fakePi();
  const handle = createScopedHermesMemory({
    storageRoot: root,
    complete: stub,
    // 120 chars: the two-entry fixture above sits over goal, the merged
    // single entry lands under it. Deterministic, no default-limit drift.
    config: { memoryCharLimit: 120 },
  })(fake.pi);
  handles.push(handle);
  return { handle, root };
}

const shrinkPlan = JSON.stringify({
  operations: [
    { action: "remove", target: "memory", old_text: "alpha verbose duplicate one" },
    { action: "remove", target: "memory", old_text: "alpha verbose duplicate two" },
    { action: "add", target: "memory", content: "alpha: merged" },
  ],
});

describe("manual compaction (handle.compact)", () => {
  it("shrinks an over-goal memory store back inside the capacity face", async () => {
    const stub = completion(shrinkPlan);
    const { handle } = openOverGoal("shrink", stub.complete);
    await handle.ready;
    assert.ok(
      handle.store.capacityUsage("memory") > handle.store.capacityGoal("memory"),
      "precondition: fixture starts over goal",
    );

    const result = await handle.compact();
    assert.equal(result.consolidated, true, JSON.stringify(result));
    assert.equal(result.targets.length, 2, "memory + failure, no profile");
    const memory = result.targets.find((t) => t.target === "memory")!;
    assert.equal(memory.consolidated, true);
    assert.equal(memory.noop, false);
    assert.ok(
      handle.store.capacityUsage("memory") <= handle.store.capacityGoal("memory"),
      "the capacity face converged — the behavior the host record promises",
    );
  });

  it("within-goal stores are a free no-op — zero completion calls", async () => {
    const root = tempRoot("noop");
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, MEMORY_FILE), "tiny fact");
    const stub = completion(shrinkPlan);
    const fake = fakePi();
    const handle = createScopedHermesMemory({ storageRoot: root, complete: stub.complete })(fake.pi);
    handles.push(handle);
    await handle.ready;

    const result = await handle.compact();
    assert.equal(result.consolidated, true);
    assert.ok(result.targets.every((t) => t.noop), "both targets within goal");
    assert.equal(stub.calls(), 0, "a healthy tenant never pays an LLM call");
  });

  it("without a completion capability compact() skips", async () => {
    const root = tempRoot("nocap");
    const fake = fakePi();
    const handle = createScopedHermesMemory({ storageRoot: root })(fake.pi);
    handles.push(handle);
    await handle.ready;

    const result = await handle.compact();
    assert.equal(result.skipped, "no-completion");
    assert.equal(result.targets.length, 0);
    assert.equal(result.deferred, undefined, "a skip never claims the gate it cannot use");
  });

  it("defers honestly while a pass is already in flight (one slot per tenant)", async () => {
    const stub = completion(shrinkPlan);
    const { handle } = openOverGoal("defer", stub.complete);
    await handle.ready;

    const first = handle.compact();
    const second = await handle.compact();
    assert.equal(second.deferred, true, JSON.stringify(second));
    assert.equal(second.targets.length, 0);
    const firstResult = await first;
    assert.equal(firstResult.consolidated, true, "the holder finished normally");
    const third = await handle.compact();
    assert.notEqual(third.deferred, true, "gate released after the holder");
  });

  it("the overflow-grace loop: add rejected → compact → add succeeds", async () => {
    // The grace window only exists where the cap is enforced (memoryMode
    // defaults to policy-only, which never rejects an add — capEnforced,
    // memory-store.ts:150-152). legacy-inject is the shape a capacity-bound
    // host runs. First add: overflowSince stamps now → overflowGraceActive
    // is true immediately → the auto path defers with "consolidate manually
    // first" (memory-store.ts:322-330). That manual path is exactly #12.
    const stub = completion(shrinkPlan);
    const root = tempRoot("grace");
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILE),
      "alpha verbose duplicate one <!-- created=2026-01-01, last=2026-01-01 -->\n§\n"
      + "alpha verbose duplicate two <!-- created=2026-01-01, last=2026-01-01 -->",
    );
    const fake = fakePi();
    const handle = createScopedHermesMemory({
      storageRoot: root,
      complete: stub.complete,
      config: { memoryCharLimit: 120, memoryMode: "legacy-inject" },
    })(fake.pi);
    handles.push(handle);
    await handle.ready;

    const overflow = await handle.store.add("one more fact", "memory");
    assert.equal(overflow.success, false, "precondition: the store is full");
    assert.match(overflow.error ?? "", /Memory at /);
    assert.match(
      overflow.error ?? "",
      /consolidate[\s\S]*manually/i,
      "the grace deferral tells the writer to compact manually — today that is a dead letter",
    );

    const result = await handle.compact();
    assert.equal(result.consolidated, true, JSON.stringify(result));
    const retry = await handle.store.add("fits now", "memory");
    assert.equal(retry.success, true, `post-compact add must succeed: ${retry.error ?? ""}`);
  });

  it("the shared profile never receives a compaction pass", async () => {
    const stub = completion(shrinkPlan);
    // Sibling roots (roots.ts:112 disjoint guard): storageRoot and sharedRoot
    // must not nest — same construction as shared-layer.test.ts.
    const base = tempRoot("profile");
    const scope = path.join(base, "scope");
    const shared = path.join(base, "profile");
    fs.mkdirSync(path.join(scope, "memory"), { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(
      path.join(scope, "memory", MEMORY_FILE),
      "alpha verbose duplicate one <!-- created=2026-01-01, last=2026-01-01 -->\n§\n"
      + "alpha verbose duplicate two <!-- created=2026-01-01, last=2026-01-01 -->",
    );
    const fake = fakePi();
    const handle = createScopedHermesMemory({
      storageRoot: scope,
      sharedRoot: shared,
      complete: stub.complete,
      config: { memoryCharLimit: 120 },
    })(fake.pi);
    handles.push(handle);
    await handle.ready;
    const profile = handle.profileStore!;
    const userBefore = profile.getUserEntries().join("§");

    const result = await handle.compact();
    assert.deepEqual(
      result.targets.map((t) => t.target).sort(),
      ["failure", "memory"],
      "type-level contract: user is not a compaction target",
    );
    assert.equal(profile.getUserEntries().join("§"), userBefore, "profile untouched");
  });

  it("a non-shrinking plan reports failure honestly and leaves the store intact", async () => {
    const growPlan = JSON.stringify({
      operations: [
        { action: "add", target: "memory", content: "an entirely new long entry nobody asked for that grows the store" },
      ],
    });
    const stub = completion(growPlan);
    const { handle } = openOverGoal("nogrow", stub.complete);
    await handle.ready;
    const before = handle.store.getMemoryEntries().join("§");

    const result = await handle.compact();
    const memory = result.targets.find((t) => t.target === "memory")!;
    assert.equal(result.consolidated, false);
    assert.equal(memory.consolidated, false);
    assert.ok(memory.error, "the pass must carry the failure reason");
    assert.equal(handle.store.getMemoryEntries().join("§"), before, "requireShrink kept the store byte-identical");
  });

  it("a mid-pass teardown stops cleanly — no write lands on a closed handle", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => { release = res; });
    const slow: MemoryCompletion = async (req) => {
      await gate;
      return { text: JSON.stringify({ operations: [] }), ok: !req.signal?.aborted };
    };
    const { handle } = openOverGoal("dispose", slow);
    await handle.ready;
    const inFlight = handle.compact();
    // dispose before the completion resolves: dbClosed flips, the second
    // target must report disposed rather than writing through a closed DB.
    await handle.dispose();
    release();
    const result = await inFlight;
    assert.equal(result.consolidated, false);
    const failed = result.targets.filter((t) => !t.consolidated && t.error === "disposed");
    assert.ok(
      failed.length >= 1 || result.targets.every((t) => t.consolidated),
      `either a pass stopped at teardown (${JSON.stringify(result)}) or none needed it`,
    );
    handles.splice(handles.indexOf(handle), 1);
  });

  it("the provider descriptor declares memoryCompaction", async () => {
    const providerModule = await import("../../src/scoped/provider.js");
    const caps = providerModule.default.capabilities;
    assert.equal(caps?.memoryCompaction, true, "host C6 detection reads this verbatim");
    assert.equal(caps?.sharedProfile, true);
    assert.equal(caps?.dataRetention, true);
  });
});

describe("provider compact() → MaintenanceResult mapping", () => {
  it("maps counts and status across the port, never content", async () => {
    const providerModule = await import("../../src/scoped/provider.js");
    const root = tempRoot("map");
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    // Default 5000-char limit: two long entries push over goal so the pass
    // does real work (affected=1); the marker string must never cross the port.
    const longA = "ZMARKER-alpha " + "a".repeat(3000);
    const longB = "beta fact " + "b".repeat(3000);
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILE),
      `${longA}\n§\n${longB}`,
    );
    const plan = JSON.stringify({
      operations: [
        { action: "remove", target: "memory", old_text: "ZMARKER-alpha" },
      ],
    });
    const stub = completion(plan);
    const session = await providerModule.default.open({
      storageRoot: root,
      complete: stub.complete,
    });
    const result = await session.compact();
    await session.dispose();

    assert.equal(typeof result.affected, "number");
    assert.equal(result.affected, 1, "one target did real work");
    assert.deepEqual(result.errors, []);
    assert.equal(result.skipped, undefined);
    assert.equal(result.deferred, undefined);
    const json = JSON.stringify(result);
    assert.ok(!json.includes("ZMARKER") && !json.includes("beta"), `no memory content crosses the port: ${json.slice(0, 120)}`);
  });
});
