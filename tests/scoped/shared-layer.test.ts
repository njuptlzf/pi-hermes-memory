import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openScopedHermesMemory, type ScopedHermesHandle } from "../../src/scoped/entry.js";
import { buildScopedMemoryPolicy } from "../../src/scoped/policy.js";
import { resolveScopedRoots, SCOPED_ROOT_ERROR } from "../../src/scoped/roots.js";
import { MEMORY_FILE, USER_FILE } from "../../src/constants.js";

/**
 * 跨会话用户级层（sharedRoot）的四条不变量，每条都对应一个会真出事的场景：
 *   1. 同一用户的 A/B 两个 scope 共享 profile —— 这是这层的存在理由。
 *   2. scope 私有记忆不跨 scope —— 否则这层就成了泄露通道。
 *   3. 擦除 scope 不动 profile —— 否则"删掉这门课"会顺手删掉用户身份。
 *   4. 两个根不得重叠 —— 否则擦除语义本身就是错的。
 */

const roots: string[] = [];
const handles: ScopedHermesHandle[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-layer-${label}-`));
  roots.push(dir);
  return dir;
}

function open(scope: string, shared: string | null): ScopedHermesHandle {
  const handle = openScopedHermesMemory({ storageRoot: scope, sharedRoot: shared });
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("cross-scope user profile", () => {
  it("shows one scope's user preference in another scope of the same user", async () => {
    const shared = tempRoot("shared");
    const scopeA = tempRoot("scope-a");
    const scopeB = tempRoot("scope-b");

    const a = open(scopeA, shared);
    await a.ready;
    await a.store.add("user", "回答用中文，别啰嗦");

    const b = open(scopeB, shared);
    const section = await b.promptSection();

    assert.match(section, /回答用中文/);
    assert.match(section, /shared-across-scopes/);
  });

  it("keeps scope memory out of the neighbouring scope", async () => {
    const shared = tempRoot("shared");
    const scopeA = tempRoot("scope-a");
    const scopeB = tempRoot("scope-b");

    const a = open(scopeA, shared);
    await a.ready;
    await a.store.add("memory", "A 科目的复习顺序是先公式后真题");

    const b = open(scopeB, shared);
    const section = await b.promptSection();

    assert.doesNotMatch(section, /先公式后真题/);
    assert.equal(fs.existsSync(path.join(b.layout.memoryDir, MEMORY_FILE)), false);
    assert.match(
      fs.readFileSync(path.join(a.layout.memoryDir, MEMORY_FILE), "utf-8"),
      /先公式后真题/,
    );
  });

  it("routes user writes to the profile file, not the scope file", async () => {
    const shared = tempRoot("shared");
    const scope = tempRoot("scope");
    const handle = open(scope, shared);
    await handle.ready;

    await handle.store.add("user", "我是上班族，只有晚上能学");
    await handle.store.add("memory", "这门课 3 月考试");

    const profileFile = path.join(handle.layout.profileDir as string, USER_FILE);
    assert.match(fs.readFileSync(profileFile, "utf-8"), /只有晚上能学/);
    assert.doesNotMatch(fs.readFileSync(profileFile, "utf-8"), /3 月考试/);
    assert.match(
      fs.readFileSync(path.join(handle.layout.memoryDir, MEMORY_FILE), "utf-8"),
      /3 月考试/,
    );
  });

  it("erases the scope without touching the profile, and the profile only on request", async () => {
    const shared = tempRoot("shared");
    const scope = tempRoot("scope");

    const first = open(scope, shared);
    await first.ready;
    await first.store.add("user", "偏好：先给结论");
    await first.store.add("memory", "scope-scoped fact");

    await first.erase();
    assert.equal(fs.existsSync(scope), false);
    assert.equal(fs.existsSync(shared), true, "scope erasure must not delete the user's identity");

    const second = open(tempRoot("scope-2"), shared);
    assert.match(await second.promptSection(), /偏好：先给结论/);

    await second.erase({ includeShared: true });
    assert.equal(fs.existsSync(shared), false);
  });

  it("refuses overlapping roots", () => {
    const scope = tempRoot("scope");
    assert.throws(
      () => resolveScopedRoots({ storageRoot: scope, sharedRoot: path.join(scope, "profile") }),
      new RegExp(SCOPED_ROOT_ERROR),
    );
    assert.throws(
      () => resolveScopedRoots({ storageRoot: path.join(scope, "a"), sharedRoot: scope }),
      new RegExp(SCOPED_ROOT_ERROR),
    );
  });

  it("stays scope-only when no shared root is given", async () => {
    const scope = tempRoot("solo");
    const handle = open(scope, null);
    await handle.ready;

    assert.equal(handle.layout.profileDir, null);
    assert.equal(handle.profileStore, null);
    await handle.store.add("user", "scope-only preference");
    assert.match(
      fs.readFileSync(path.join(handle.layout.memoryDir, USER_FILE), "utf-8"),
      /scope-only preference/,
    );
  });
});

describe("scoped policy prompt", () => {
  it("never claims a global layer or an unmounted tool", () => {
    const policy = buildScopedMemoryPolicy({ hasSharedProfile: true });

    assert.doesNotMatch(policy, /global notes/i);
    assert.doesNotMatch(policy, /memory_search/);
    assert.doesNotMatch(policy, /project-specific/);
    assert.match(policy, /no global layer/i);
    assert.match(policy, /visible in every scope/i);
  });

  it("describes the search tool only when it is mounted", () => {
    const withoutSearch = buildScopedMemoryPolicy({});
    const withSearch = buildScopedMemoryPolicy({ hasSearch: true });

    assert.doesNotMatch(withoutSearch, /memory_search/);
    assert.match(withSearch, /memory_search/);
  });

  it("marks the profile as shared only when the layer exists", () => {
    assert.match(buildScopedMemoryPolicy({ hasSharedProfile: true }), /every scope that user works in/);
    assert.match(buildScopedMemoryPolicy({ hasSharedProfile: false }), /for this conversation's scope only/);
  });
});
