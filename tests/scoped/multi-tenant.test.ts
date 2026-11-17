import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createScopedHermesMemory, type ScopedHermesHandle } from "../../src/scoped/entry.js";
import { isInsideRoot, resolveScopedRoots, SCOPED_ROOT_ERROR } from "../../src/scoped/roots.js";
import { MEMORY_FILE } from "../../src/constants.js";

/**
 * The point of this suite is the invariant a multi-tenant host depends on:
 * two tenants constructed in the SAME process, with nothing but their own
 * storage root, must not be able to write into each other's directory — and
 * must not be able to pick up a machine-wide default when they forget one.
 *
 * The host-facing form is the curried one, because that is what an
 * `extensionFactories: [...]` array takes: `scopedMemory({ dir })` in
 * agent-chat is a factory, not an imperative mount.
 */

function fakePi(): { pi: ExtensionAPI; tools: string[]; handlers: Map<string, unknown> } {
  const tools: string[] = [];
  const handlers = new Map<string, unknown>();
  const pi = {
    on(event: string, handler: unknown) {
      handlers.set(event, handler);
    },
    registerTool(tool: { name: string }) {
      tools.push(tool.name);
      return true;
    },
  } as unknown as ExtensionAPI;
  return { pi, tools, handlers };
}

const tempDirs: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-scoped-${label}-`));
  tempDirs.push(dir);
  return dir;
}

/** Mount a tenant exactly the way a host would: factory first, then pi. */
function mount(storageRoot: string): { handle: ScopedHermesHandle; pi: ReturnType<typeof fakePi> } {
  const fake = fakePi();
  const handle = createScopedHermesMemory({ storageRoot })(fake.pi);
  handles.push(handle);
  return { handle, pi: fake };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scoped hermes entry — multi-tenant isolation", () => {
  it("keeps two tenants' memories in separate directories", async () => {
    const rootA = tempRoot("a");
    const rootB = tempRoot("b");
    const a = mount(rootA).handle;
    const b = mount(rootB).handle;

    assert.notStrictEqual(a.layout.memoryDir, b.layout.memoryDir);
    assert.ok(isInsideRoot(rootA, a.layout.memoryDir));
    assert.ok(isInsideRoot(rootB, b.layout.memoryDir));

    await a.ready;
    await b.ready;
    await a.store.add("memory", "tenant A prefers dark mode");
    await b.store.add("memory", "tenant B prefers light mode");

    const memoryA = fs.readFileSync(path.join(a.layout.memoryDir, MEMORY_FILE), "utf-8");
    const memoryB = fs.readFileSync(path.join(b.layout.memoryDir, MEMORY_FILE), "utf-8");

    assert.match(memoryA, /tenant A prefers dark mode/);
    assert.doesNotMatch(memoryA, /tenant B/);
    assert.match(memoryB, /tenant B prefers light mode/);
    assert.doesNotMatch(memoryB, /tenant A/);
  });

  it("registers its tools per instance rather than per process", () => {
    const first = mount(tempRoot("t1"));
    const second = mount(tempRoot("t2"));

    assert.ok(first.pi.tools.length > 0, "expected the memory tool to be registered");
    assert.deepStrictEqual(first.pi.tools, second.pi.tools);
    assert.ok(first.pi.handlers.has("before_agent_start"));
    assert.ok(first.pi.handlers.has("session_start"));
  });

  it("fails at wiring time, not first use, when the root is unusable", () => {
    assert.throws(() => createScopedHermesMemory({ storageRoot: "relative/path" }), new RegExp(SCOPED_ROOT_ERROR));
  });

  it("refuses a second live handle on the same tenant root", () => {
    const root = tempRoot("dup");
    mount(root);

    assert.throws(
      () => createScopedHermesMemory({ storageRoot: root })(fakePi().pi),
      /SCOPED_ROOT_IN_USE/,
    );
  });

  it("releases the root claim and the lock database on dispose", async () => {
    const root = tempRoot("reuse");
    const first = createScopedHermesMemory({ storageRoot: root })(fakePi().pi);
    await first.ready;
    await first.store.add("memory", "will be erased");
    await first.dispose();

    // Erasure is the contract: a discontinued tenant's directory must be
    // removable on Windows, which requires its lock database to be closed.
    fs.rmSync(root, { recursive: true, force: true });
    assert.strictEqual(fs.existsSync(root), false);

    const second = mount(root);
    assert.strictEqual(second.handle.roots.storageRoot, path.normalize(root));
  });

  it("erases one tenant without touching its neighbour", async () => {
    const doomedRoot = tempRoot("doomed");
    const keptRoot = tempRoot("kept");
    const doomed = mount(doomedRoot).handle;
    const kept = mount(keptRoot).handle;

    await doomed.store.add("memory", "erase me");
    await kept.store.add("memory", "keep me");

    await doomed.erase();

    assert.strictEqual(fs.existsSync(doomedRoot), false);
    assert.strictEqual(fs.existsSync(keptRoot), true);
    assert.match(
      fs.readFileSync(path.join(kept.layout.memoryDir, MEMORY_FILE), "utf-8"),
      /keep me/,
    );

    // The claim must be released too, or the tenant can never come back.
    const reborn = mount(doomedRoot);
    assert.strictEqual(reborn.handle.layout.memoryDir, doomed.layout.memoryDir);
  });

  it("exposes the same prompt section it injects through the hook", async () => {
    const { handle } = mount(tempRoot("prompt"));
    const section = await handle.promptSection();

    assert.equal(typeof section, "string");
    assert.ok(section.length > 0, "a policy-only store should still produce a policy section");
  });

  it("cannot be pointed at a machine-wide or relative root", () => {
    assert.throws(() => resolveScopedRoots({ storageRoot: "relative/path" }), new RegExp(SCOPED_ROOT_ERROR));
    assert.throws(() => resolveScopedRoots({ storageRoot: "   " }), new RegExp(SCOPED_ROOT_ERROR));
    assert.throws(() => resolveScopedRoots({ storageRoot: path.parse(process.cwd()).root }), /filesystem root/);
    assert.throws(
      () => resolveScopedRoots({ storageRoot: tempRoot("nul"), runtimeRoot: "runtime" }),
      new RegExp(SCOPED_ROOT_ERROR),
    );
  });

  it("treats a sibling directory with a shared prefix as outside the root", () => {
    const root = path.join(os.tmpdir(), "tenant-a");
    assert.strictEqual(isInsideRoot(root, path.join(root, "memory")), true);
    assert.strictEqual(isInsideRoot(root, path.join(os.tmpdir(), "tenant-ab", "memory")), false);
    assert.strictEqual(isInsideRoot(root, path.join(root, "..", "tenant-b")), false);
  });
});
