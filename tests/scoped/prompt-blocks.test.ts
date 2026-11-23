import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { replaceOwnedBlocks } from "../../src/scoped/prompt-blocks.js";
import { openScopedHermesMemory, type ScopedHermesHandle } from "../../src/scoped/entry.js";
import type { MemoryCompletion } from "../../src/scoped/completion-types.js";

/**
 * P5 / D1: the scoped prompt section must land exactly once on the host path.
 *
 * The port owns injection twice: `selfInjects:false` means the host pre-renders
 * `promptSection()` into its loader, and the entry also appends it from
 * `before_agent_start`. The fix strips our own tag namespaces before appending
 * the fresh copy, so a mid-session profile correction cannot leave a stale
 * duplicate behind. Design record: docs/fork/P5-STANDING-DESIGN.md §4.4, §7
 * tests 9-13, plus the R8 reviewEnabled port-gap case.
 */

interface Handler { (event: any, ctx?: any): Promise<any> | any }

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-prompt-blocks-${label}-`));
  roots.push(dir);
  return dir;
}

/** Mount through the real entry and capture every hook the host would fire. */
function mount(options: {
  storageRoot: string;
  sharedRoot?: string | null;
  complete?: MemoryCompletion;
  tuning?: any;
}): {
  handle: ScopedHermesHandle;
  handlers: Map<string, Handler[]>;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() { return true; },
  } as unknown as ExtensionAPI;
  const handle = openScopedHermesMemory(options);
  handle.mount(pi);
  handles.push(handle);
  return { handle, handlers };
}

const count = (text: string, tag: string): number =>
  text.split(`<${tag}`).length - 1;

function branch(): any[] {
  return [
    { type: "message", message: { role: "user", content: "user message 0" } },
    { type: "message", message: { role: "assistant", content: "assistant reply 0" } },
  ];
}
const ctx = { sessionManager: { getBranch: () => branch() } } as any;

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function fireBeforeAgentStart(handlers: Map<string, Handler[]>, event: any): Promise<any> {
  let override: any;
  for (const handler of handlers.get("before_agent_start") ?? []) {
    const result = await handler(event, ctx);
    if (result?.systemPrompt) override = result;
  }
  return override;
}

describe("D1: prompt section is injected exactly once", () => {
  it("test 9 — idempotent under the host's pre-injection", async () => {
    const { handle, handlers } = mount({ storageRoot: tempRoot("idem") });
    const section = await handle.promptSection();
    assert.ok(count(section, "memory-policy") >= 1, "fixture section must carry a policy block");

    const event = {
      systemPrompt: "base prompt",
      systemPromptOptions: {
        sections: {},
        appendSystemPrompt: section, // host already injected it
      },
    };
    await fireBeforeAgentStart(handlers, event);

    const result = String(event.systemPromptOptions.appendSystemPrompt);
    assert.equal(count(result, "memory-policy"), 1, "one policy block after the handler");
    assert.equal(count(result, "user-profile"), 0);
  });

  it("test 10 — a profile entry removed mid-session is not resurrected by the stale host copy", async () => {
    // A sharedRoot is required for the <user-profile> block to render at all.
    const { handle, handlers } = mount({
      storageRoot: tempRoot("fresh-scope"),
      sharedRoot: tempRoot("fresh-shared"),
    });
    await handle.store.add("user", "WRONG_OLD_FACT: the user's old correction");
    await handle.store.add("user", "STILL_TRUE_FACT: the user's stable preference");
    const t0 = await handle.promptSection();
    assert.match(t0, /WRONG_OLD_FACT/);

    await handle.store.remove("user", "WRONG_OLD_FACT: the user's old correction");
    const t1 = await handle.promptSection();
    assert.doesNotMatch(t1, /WRONG_OLD_FACT/, "fresh section must drop the corrected fact");
    assert.match(t1, /STILL_TRUE_FACT/);

    const event = {
      systemPrompt: "base prompt",
      systemPromptOptions: { sections: {}, appendSystemPrompt: t0 },
    };
    await fireBeforeAgentStart(handlers, event);

    const result = String(event.systemPromptOptions.appendSystemPrompt);
    assert.equal(count(result, "user-profile"), 1, "one user-profile block");
    assert.doesNotMatch(result, /WRONG_OLD_FACT/, "the corrected fact must not survive");
  });

  it("test 11 — foreign product text survives; only our tag namespaces go", async () => {
    const { handle, handlers } = mount({ storageRoot: tempRoot("foreign") });
    const section = await handle.promptSection();
    const product = [
      "<qualification>Product copy about memory-policy in prose</qualification>",
      "<skills>skill list</skills>",
    ].join("\n");

    const event = {
      systemPrompt: "base prompt",
      systemPromptOptions: { sections: {}, appendSystemPrompt: `${product}\n\n${section}` },
    };
    await fireBeforeAgentStart(handlers, event);

    const result = String(event.systemPromptOptions.appendSystemPrompt);
    assert.match(result, /<qualification>Product copy about memory-policy in prose<\/qualification>/);
    assert.match(result, /<skills>skill list<\/skills>/);
    assert.equal(count(result, "memory-policy"), 1);
  });

  it("test 12 — both pi branches end with one copy", async () => {
    const a = mount({ storageRoot: tempRoot("branch-a") });
    const sectionA = await a.handle.promptSection();
    const eventA = {
      systemPrompt: "base prompt",
      systemPromptOptions: { sections: {}, appendSystemPrompt: sectionA },
    };
    await fireBeforeAgentStart(a.handlers, eventA);
    assert.equal(count(String(eventA.systemPromptOptions.appendSystemPrompt), "memory-policy"), 1,
      "pi 1.5.x sections branch");

    const b = mount({ storageRoot: tempRoot("branch-b") });
    const sectionB = await b.handle.promptSection();
    // 0.80.x: no `sections` key; the handler returns the whole systemPrompt.
    const eventB = { systemPrompt: `base prompt\n\n${sectionB}`, systemPromptOptions: {} };
    const override = await fireBeforeAgentStart(b.handlers, eventB);
    assert.ok(override, "0.80.x branch must return a systemPrompt override");
    assert.equal(count(String(override.systemPrompt), "memory-policy"), 1, "pi 0.80.x fallthrough branch");
  });

  it("test 13 — replaceOwnedBlocks is idempotent on a second pass", () => {
    const fresh = "<memory-policy>v2</memory-policy>";
    const seeded = `<tools/>\n\n<memory-policy>v1</memory-policy>\n\n<cwd/>`;
    const once = replaceOwnedBlocks(seeded, fresh);
    const twice = replaceOwnedBlocks(once, fresh);
    assert.equal(twice, once);
    assert.match(once, /<tools\/>/);
    assert.match(once, /<cwd\/>/);
    assert.equal(count(once, "memory-policy"), 1);
  });
});

describe("R8: reviewEnabled reaches the port", () => {
  it("tuning.reviewEnabled: false stops review and flush through open()", async () => {
    let called = 0;
    const { handlers } = mount({
      storageRoot: tempRoot("review-off"),
      complete: async () => { called++; return { text: "{}", ok: true }; },
      // Chain A: config-mapped field; the entry must fold it into config.
      tuning: { reviewEnabled: false, reviewEveryTurns: 1, minUserTurnsBeforeReview: 0 },
    });

    for (const handler of handlers.get("message_end") ?? []) {
      await handler({ message: { role: "user", content: "u0" } }, ctx);
    }
    for (const handler of handlers.get("turn_end") ?? []) {
      await handler({ toolResults: [] }, ctx);
    }
    for (const handler of handlers.get("session_shutdown") ?? []) {
      await handler({}, ctx);
    }
    assert.equal(called, 0, "a disabled switch must produce no completion call");

    // The config field itself must carry the port value, not just be inert.
    const direct = openScopedHermesMemory({
      storageRoot: tempRoot("review-off-config"),
      tuning: { reviewEnabled: false },
    });
    handles.push(direct);
    assert.equal(direct.config.reviewEnabled, false,
      "tuning.reviewEnabled must fold into config.reviewEnabled (Chain A)");
  });

  it("tuning.reviewEnabled: true still allows review to fire", async () => {
    let called = 0;
    const { handlers } = mount({
      storageRoot: tempRoot("review-on"),
      complete: async () => { called++; return { text: "{}", ok: true }; },
      tuning: {
        reviewEnabled: true, reviewEveryTurns: 1, nudgeMode: "turn",
        minUserTurnsBeforeReview: 0,
      },
    });

    // Feed one qualifying turn; the default minUserTurns guard is set to 0.
    for (const handler of handlers.get("turn_end") ?? []) {
      await handler({ toolResults: [] }, ctx);
    }
    assert.equal(called, 1, "an enabled switch must let the review run");
  });
});
