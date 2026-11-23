import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openScopedHermesMemory, type ScopedHermesHandle } from "../../src/scoped/entry.js";
import { STANDING_FILE, STANDING_MAX_ENTRIES } from "../../src/constants.js";

/**
 * P5 candidate #8: user-pinned STANDING.md reaches the prompt at the user
 * level (beside USER.md), rendered last, read-only, no upstream file touched.
 * Mounted through the real entry with a fake pi so a wiring regression fails.
 * Design record: docs/fork/P5-STANDING-DESIGN.md §7 tests 1-8.
 */

interface Handler { (event: any, ctx?: any): Promise<any> | any }
interface CapturedTool { name: string }

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-standing-${label}-`));
  roots.push(dir);
  return dir;
}

function mount(options: {
  storageRoot: string;
  sharedRoot?: string | null;
  tuning?: any;
}): {
  handle: ScopedHermesHandle;
  handlers: Map<string, Handler[]>;
  tools: string[];
} {
  const handlers = new Map<string, Handler[]>();
  const tools: string[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: CapturedTool) {
      tools.push(tool.name);
      return true;
    },
  } as unknown as ExtensionAPI;
  const handle = openScopedHermesMemory(options);
  handle.mount(pi);
  handles.push(handle);
  return { handle, handlers, tools };
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writePins(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf-8");
}

describe("P5 #8: standing instructions wiring", () => {
  it("test 1 — standingFile is absolute and sits where USER.md sits", async () => {
    const shared = tempRoot("shared");
    const scope = tempRoot("scope");
    const withShared = mount({ storageRoot: scope, sharedRoot: shared });
    const { handle } = withShared;

    assert.ok(path.isAbsolute(handle.layout.standingFile), "standingFile must be absolute, not a bare name");
    assert.equal(handle.layout.standingFile, path.join(handle.layout.profileDir!, STANDING_FILE));
    const userPath = await handle.store.getStorageIdentity("user");
    assert.equal(path.dirname(handle.layout.standingFile), path.dirname(userPath),
      "pins must live beside USER.md at the user level");

    const scopeOnly = mount({ storageRoot: tempRoot("scope-only") }).handle;
    assert.equal(scopeOnly.layout.standingFile, path.join(scopeOnly.layout.memoryDir, STANDING_FILE));
    const scopeUserPath = await scopeOnly.store.getStorageIdentity("user");
    assert.equal(path.dirname(scopeOnly.layout.standingFile), path.dirname(scopeUserPath));
  });

  it("test 2 — a tenant's pins reach its prompt section, last", async () => {
    const { handle } = mount({
      storageRoot: tempRoot("pins-scope"),
      sharedRoot: tempRoot("pins-shared"),
    });
    writePins(handle.layout.standingFile, [
      "回答一律用中文，代码注释用英文",
      "不要执行 rm -rf，先列清单让我确认",
    ]);

    const section = await handle.promptSection();
    const standingAt = section.indexOf("<standing-instructions>");
    const profileAt = section.indexOf("<user-profile");
    const policyAt = section.indexOf("<memory-policy>");
    assert.ok(standingAt >= 0, "standing block must be present");
    assert.ok(standingAt > profileAt && standingAt > policyAt, "standing block must be last");
    assert.match(section, /回答一律用中文/);
    assert.match(section, /不要执行 rm -rf/);
  });

  it("test 3 — level semantics: shared across a user's scopes, isolated across users", async () => {
    const shared = tempRoot("level-shared");
    const a = mount({ storageRoot: tempRoot("level-a"), sharedRoot: shared }).handle;
    const b = mount({ storageRoot: tempRoot("level-b"), sharedRoot: shared }).handle;
    assert.equal(a.layout.standingFile, b.layout.standingFile,
      "two scopes of one user must resolve the same pin file");

    writePins(a.layout.standingFile, ["USER_LEVEL_RULE"]);
    assert.match(await a.promptSection(), /USER_LEVEL_RULE/);
    assert.match(await b.promptSection(), /USER_LEVEL_RULE/, "the second scope must see the same rule");

    const other = mount({
      storageRoot: tempRoot("level-c"),
      sharedRoot: tempRoot("level-other-shared"),
    }).handle;
    assert.notEqual(other.layout.standingFile, a.layout.standingFile);
    assert.doesNotMatch(await other.promptSection(), /USER_LEVEL_RULE/,
      "a different user must never see the rule");

    const scopeOnly = mount({ storageRoot: tempRoot("level-solo") }).handle;
    writePins(scopeOnly.layout.standingFile, ["SOLO_RULE"]);
    assert.match(await scopeOnly.promptSection(), /SOLO_RULE/);
    assert.doesNotMatch(await other.promptSection(), /SOLO_RULE/);
  });

  it("test 4 — tuning.standingInstructions: false stops the read", async () => {
    const root = tempRoot("off-scope");
    const shared = tempRoot("off-shared");
    const on = mount({ storageRoot: root, sharedRoot: shared }).handle;
    writePins(on.layout.standingFile, ["SHOULD_NOT_APPEAR"]);
    assert.match(await on.promptSection(), /SHOULD_NOT_APPEAR/);

    // A second handle on a fresh scope with the switch off; the shared pin
    // file still exists but the disabled tenant must not read it.
    const off = mount({
      storageRoot: tempRoot("off-scope-2"),
      sharedRoot: shared,
      tuning: { standingInstructions: false },
    }).handle;
    assert.equal(off.config.standingInstructionsEnabled, false,
      "tuning.standingInstructions must fold into config (Chain A)");
    const section = await off.promptSection();
    assert.doesNotMatch(section, /<standing-instructions>/);
    assert.doesNotMatch(section, /SHOULD_NOT_APPEAR/);
  });

  it("test 5 — no file (or an empty one) yields a byte-identical section", async () => {
    const absent = mount({ storageRoot: tempRoot("absent") }).handle;
    const empty = mount({ storageRoot: tempRoot("empty") }).handle;
    fs.mkdirSync(path.dirname(empty.layout.standingFile), { recursive: true });
    fs.writeFileSync(empty.layout.standingFile, "", "utf-8");

    assert.equal(await empty.promptSection(), await absent.promptSection(),
      "activation must not change output for a tenant with no pins");
  });

  it("test 6 — the budget is upstream's, not restated", async () => {
    const { handle } = mount({ storageRoot: tempRoot("budget") });
    const lines = Array.from({ length: STANDING_MAX_ENTRIES + 2 }, (_, i) => `rule ${i + 1}`);
    writePins(handle.layout.standingFile, lines);

    const block = (await handle.promptSection()).split("<standing-instructions>")[1] ?? "";
    const injected = (block.match(/^\d+\. /gm) ?? []).length;
    assert.equal(injected, STANDING_MAX_ENTRIES, "injected count must be capped at the upstream constant");
    assert.match(block, /further standing instructions could not be shown/,
      "over-budget notice must be rendered, not silently dropped");
  });

  it("test 7 — pins are read through the entry, not the store", async () => {
    // The file already exists BEFORE open(); only promptSection() wiring makes
    // it appear. A design that merely adds the layout field fails here.
    const root = tempRoot("before-open");
    const shared = tempRoot("before-open-shared");
    const probe = openScopedHermesMemory({ storageRoot: root, sharedRoot: shared });
    handles.push(probe);
    writePins(probe.layout.standingFile, ["PIN_WRITTEN_BEFORE_OPEN"]);
    await probe.dispose();
    handles.pop();

    const { handle } = mount({ storageRoot: root, sharedRoot: shared });
    assert.match(await handle.promptSection(), /PIN_WRITTEN_BEFORE_OPEN/);
  });

  it("test 8 — no write surface is mounted; the pin file is untouched", async () => {
    const { handle, tools, handlers } = mount({
      storageRoot: tempRoot("nowrite-scope"),
      sharedRoot: tempRoot("nowrite-shared"),
    });
    writePins(handle.layout.standingFile, ["LOCKED_RULE"]);
    const before = fs.readFileSync(handle.layout.standingFile, "utf-8");

    // registerMemoryTool mounts add/remove/replace; registerMemorySearchTool
    // mounts search. What must NOT appear is any pin/write surface for STANDING.
    assert.ok(tools.includes("memory_add") && tools.includes("memory_search"));
    assert.equal(tools.some((name) => /pin|standing/i.test(name)), false,
      "no pin tool may be registered");
    assert.equal(handlers.has("memory_pin"), false);

    // Exercise a full turn; the pin file's bytes must not change.
    for (const handler of handlers.get("before_agent_start") ?? []) {
      await handler({ systemPrompt: "base", systemPromptOptions: { sections: {} } }, {} as any);
    }
    assert.equal(fs.readFileSync(handle.layout.standingFile, "utf-8"), before,
      "no hook or tool may rewrite the user-authored block");
  });
});
