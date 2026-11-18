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
import { MEMORY_FILE, USER_FILE } from "../../src/constants.js";

/**
 * The retrieval wiring has one job: the `memory_search` tool a tenant is told
 * it has must actually find that tenant's memories — and nothing from any
 * other tenant. Every test here drives the tools the way a host would (through
 * `pi.registerTool`), not the underlying stores, so a wiring regression is
 * caught rather than a store-level test passing while the tool is absent.
 */

interface CapturedTool {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<{
    content: Array<{ type: string; text: string }>;
    details: Record<string, unknown>;
  }>;
}

function fakePi(): {
  pi: ExtensionAPI;
  tools: Map<string, CapturedTool>;
} {
  const tools = new Map<string, CapturedTool>();
  const pi = {
    on() {},
    registerTool(def: CapturedTool) {
      tools.set(def.name, def);
      return true;
    },
  } as unknown as ExtensionAPI;
  return { pi, tools };
}

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-search-${label}-`));
  roots.push(dir);
  return dir;
}

function mount(options: { storageRoot: string; sharedRoot?: string | null }): {
  handle: ScopedHermesHandle;
  tools: Map<string, CapturedTool>;
} {
  const fake = fakePi();
  const handle = createScopedHermesMemory(options)(fake.pi);
  handles.push(handle);
  return { handle, tools: fake.tools };
}

async function add(
  tools: Map<string, CapturedTool>,
  target: string,
  content: string,
): Promise<void> {
  const result = await tools.get("memory_add")!.execute("tc", { target, content });
  assert.strictEqual(result.details.success, true, JSON.stringify(result.details));
}

async function search(
  tools: Map<string, CapturedTool>,
  query: string,
): Promise<{ count: number; text: string }> {
  const result = await tools.get("memory_search")!.execute("tc", { query });
  return {
    count: result.details.count as number,
    text: result.content[0]?.text ?? "",
  };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scoped retrieval wiring", () => {
  it("mounts memory_search and claims it in the policy prompt", async () => {
    const { handle, tools } = mount({ storageRoot: tempRoot("mount") });

    assert.ok(tools.has("memory_search"), "memory_search must be registered");
    for (const name of ["memory_add", "memory_replace", "memory_remove"]) {
      assert.ok(tools.has(name), `${name} must still be registered`);
    }
    const section = await handle.promptSection();
    assert.match(section, /memory_search/);
  });

  it("finds memories written through the write tool in the same session", async () => {
    const { tools } = mount({ storageRoot: tempRoot("write") });
    await add(tools, "memory", "deploy uses the blue cluster");

    const result = await search(tools, "blue cluster");
    assert.strictEqual(result.count, 1);
    assert.match(result.text, /blue cluster/);
  });

  it("isolates two tenants' search indexes from each other", async () => {
    const a = mount({ storageRoot: tempRoot("tenant-a") });
    const b = mount({ storageRoot: tempRoot("tenant-b") });

    await add(a.tools, "memory", "tenant A secret token ALPHA");
    await add(b.tools, "memory", "tenant B secret token BETA");

    const fromA = await search(a.tools, "secret token");
    assert.strictEqual(fromA.count, 1);
    assert.match(fromA.text, /ALPHA/);
    assert.doesNotMatch(fromA.text, /BETA/);

    const fromB = await search(b.tools, "secret token");
    assert.strictEqual(fromB.count, 1);
    assert.match(fromB.text, /BETA/);
    assert.doesNotMatch(fromB.text, /ALPHA/);
  });

  it("indexes pre-existing Markdown on open (upgrade path)", async () => {
    const root = tempRoot("seed");
    const memoryDir = path.join(root, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, MEMORY_FILE),
      "legacy fact from an older version <!-- created=2026-01-01, last=2026-01-01 -->",
    );

    const { handle, tools } = mount({ storageRoot: root });
    await handle.ready;
    const result = await search(tools, "legacy fact");
    assert.strictEqual(result.count, 1);
    assert.match(result.text, /legacy fact/);
  });

  it("makes cross-scope profile entries searchable within a scope", async () => {
    const shared = tempRoot("shared");
    const { tools } = mount({
      storageRoot: tempRoot("profile-search"),
      sharedRoot: shared,
    });
    await add(tools, "user", "user prefers terse answers");

    const result = await search(tools, "terse answers");
    assert.strictEqual(result.count, 1);
    assert.match(result.text, /terse answers/);
    assert.ok(fs.existsSync(path.join(shared, "profile", USER_FILE)));
  });

  it("releases the SQLite file so the scope directory can be erased", async () => {
    const root = tempRoot("erase");
    const { tools, handle } = mount({ storageRoot: root });
    await add(tools, "memory", "ephemeral entry");
    assert.ok(fs.existsSync(path.join(root, "memory", "sessions.db")));

    await handle.erase();

    assert.strictEqual(fs.existsSync(root), false);
  });

  it("a reborn tenant on the same root starts with an empty index", async () => {
    const root = tempRoot("reborn");
    const first = mount({ storageRoot: root });
    await add(first.tools, "memory", "old tenant entry");
    await first.handle.dispose();
    fs.rmSync(root, { recursive: true, force: true });

    const second = mount({ storageRoot: root });
    // An empty extended store reports success:false with no `count` field —
    // assert on the absence of a hit rather than assuming count === 0.
    const result = await search(second.tools, "old tenant entry");
    assert.doesNotMatch(result.text, /old tenant entry/);
    assert.notStrictEqual(result.count, 1);
  });
});
