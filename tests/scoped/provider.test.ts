import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import provider, { PROVIDER_ID, PROVIDER_VERSION } from "../../src/scoped/provider.js";

/**
 * 外部注册用到的入口只有三个字段：id、version、open。这里锁住它们，
 * 因为宿主是按形状（structural）而不是按类型来认它的——形状漂了，编译不会报错，
 * 只会在加载期抛一句看不懂的话。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];

function tempRoot(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hermes-provider-${label}-`));
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("scoped hermes provider descriptor", () => {
  it("keeps id and version stable, and the version in sync with package.json", () => {
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(provider.version, PROVIDER_VERSION);

    const pkg = JSON.parse(
      fs.readFileSync(path.join(here, "../../package.json"), "utf-8"),
    ) as { version?: string };
    // A release that bumps package.json but forgets the descriptor is exactly the
    // drift a host would report as "the version lies".
    assert.equal(pkg.version, PROVIDER_VERSION);
  });

  it("declares cross-scope profile support matching its real sharedRoot behaviour (C6)", async () => {
    // The declaration is a fact the host reads to warn a dependent product.
    // It must agree with what open() actually does with sharedRoot — otherwise
    // a provider would advertise a capability it silently drops.
    assert.equal(provider.capabilities?.sharedProfile, true);

    const shared = tempRoot("shared");
    const scope = tempRoot("scope");
    const session = await provider.open({ storageRoot: scope, sharedRoot: shared });
    try {
      const tools: string[] = [];
      session.factory({
        registerTool: (tool: { name?: string }) => {
          tools.push(String(tool.name ?? ""));
          return true;
        },
        on: () => {},
      });
      const memoryAdd = tools.find((name) => name === "memory_add");
      assert.ok(memoryAdd, "a provider claiming sharedProfile must expose the write tool");

      await session.erase();
      assert.equal(fs.existsSync(scope), false);
      assert.equal(fs.existsSync(shared), true, "scope erasure must not touch the user profile");
      await session.erase({ includeShared: true });
      assert.equal(fs.existsSync(shared), false, "explicit account deletion removes the profile");
    } finally {
      await session.dispose();
    }
  });

  it("hands prompt assembly to the host and still produces the section", async () => {
    const root = tempRoot("open");
    const session = await provider.open({ storageRoot: root });

    try {
      assert.equal(session.providerId, PROVIDER_ID);
      assert.equal(session.selfInjects, false);

      const section = await session.promptSection();
      assert.ok(section.length > 0);
      // Same text on a second call: the host may ask once per turn.
      assert.equal(await session.promptSection(), section);
    } finally {
      await session.dispose();
    }
  });

  it("mounts the memory tool and erases only its own tenant", async () => {
    const root = tempRoot("mount");
    const neighbour = tempRoot("neighbour");
    fs.writeFileSync(path.join(neighbour, "keep.txt"), "keep");

    const session = await provider.open({ storageRoot: root });
    const tools: string[] = [];
    session.factory({
      registerTool: (tool: { name?: string }) => {
        tools.push(String(tool.name ?? ""));
        return true;
      },
      on: () => {},
    });

    assert.ok(tools.length > 0, "the provider must register at least one tool");
    await session.erase();
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.existsSync(path.join(neighbour, "keep.txt")), true);
    await session.dispose();
  });

  it("refuses a missing root instead of defaulting to a machine directory", async () => {
    await assert.rejects(() => provider.open({ storageRoot: "" }), /requires an absolute storageRoot/);
    await assert.rejects(() => provider.open({ storageRoot: "relative/path" }), /must be an absolute path/);
  });
});
