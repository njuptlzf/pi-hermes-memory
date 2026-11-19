#!/usr/bin/env node
/**
 * Publish the scoped fork to the official npm registry using the machine's
 * already-configured npm token.
 *
 * Why this exists: this fork's CI publish is blocked on npm's account-level
 * 2FA (Trusted Publisher cannot be configured without a physical security
 * key). Until that is resolved, releases are cut by hand. This script makes
 * that manual step repeatable and safe.
 *
 * Token handling (C6): the script NEVER reads, prints, or passes the token.
 * npm itself authenticates from ~/.npmrc (`//registry.npmjs.org/:_authToken`).
 * We only assert that such an entry exists — a boolean check, no value read
 * into a variable, no value in logs or child-process arguments.
 *
 * Two other traps this script guards against, both hit in earlier releases:
 *   1. the local npm is pointed at npmmirror.com (stale packument), so every
 *      registry call is pinned to registry.npmjs.org with a cache-buster;
 *   2. package.json version drifting from src/scoped/provider.ts's
 *      PROVIDER_VERSION — the conformance test fails the CI gate on that.
 *
 * Usage:
 *   node scripts/publish-scoped.mjs --dry-run   # preflight only, no publish
 *   node scripts/publish-scoped.mjs             # publish under `next`
 *   node scripts/publish-scoped.mjs --tag next  # explicit dist-tag
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const REGISTRY = "https://registry.npmjs.org";
const PACKAGE = "@njuptlzf/pi-hermes-memory";
const ENCODED = "@njuptlzf%2fpi-hermes-memory";

// npm metadata can lag a successful upload by several minutes across its edges.
// 180s proved too short in practice: the version landed but the script reported
// failure. Give propagation room, then recheck through npm before giving up.
const PROPAGATION_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const tagIndex = argv.indexOf("--tag");
const tag = tagIndex !== -1 ? argv[tagIndex + 1] : "next";

if (tagIndex !== -1 && !tag) fail("--tag requires a value");
// dist-tags are a strict token; also the only user-supplied string that reaches
// a shell on Windows, so reject shell metacharacters here rather than escaping.
if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) fail(`invalid dist-tag: ${JSON.stringify(tag)}`);
if (argv.some((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--tag")) {
  fail(`unknown flag: ${argv.find((a) => a.startsWith("--") && a !== "--dry-run" && a !== "--tag")}`);
}

function fail(message) {
  console.error(`[publish-scoped] ERROR: ${message}`);
  process.exit(1);
}

// Windows ships npm as npm.cmd, which only spawns through the shell. Shell
// invocation means arguments must be validated (see the tag check below) so a
// user-supplied --tag can never become a shell metacharacter.
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    shell: WIN,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });
  if (result.error) fail(`${cmd} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    if (options.capture) return null;
    fail(`${cmd} ${args.join(" ")} exited with ${result.status}`);
  }
  return options.capture ? result.stdout.trim() : result.status;
}

/** Boolean-only token check. The matched line's value is never captured. */
function tokenConfigured() {
  const npmrc = join(homedir(), ".npmrc");
  try {
    return /^\s*\/\/registry\.npmjs\.org\/:_authToken\s*=/m.test(readFileSync(npmrc, "utf8"));
  } catch {
    return false;
  }
}

function packageVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  } catch {
    return fail("cannot read package.json version");
  }
}

function providerVersion() {
  const src = readFileSync(join(ROOT, "src/scoped/provider.ts"), "utf8");
  const match = src.match(/PROVIDER_VERSION\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

/** Fetch registry metadata with a cache-buster; returns null on any failure. */
async function registryMeta() {
  const url = `${REGISTRY}/${ENCODED}?t=${Date.now()}`;
  try {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Re-check a dist-tag through npm itself with `--prefer-online`, which bypasses
 * npm's local cache and any stale edge. Returns the resolved version string, or
 * null on failure. Independent of registryMeta()'s raw fetch so one stale path
 * cannot mask a publish that actually landed.
 */
function npmViewTag(tag) {
  return run(
    NPM,
    ["view", `${PACKAGE}@${tag}`, "version", "--registry", REGISTRY, "--prefer-online"],
    { capture: true },
  );
}

async function main() {
  const version = packageVersion();

  // A prerelease must never go to `latest` (the CI verify gate rejects it too).
  if (version.includes("-") && tag === "latest") {
    fail(`${version} is a prerelease; use a non-latest dist-tag (e.g. next)`);
  }

  if (!tokenConfigured()) {
    fail(`no auth token for ${REGISTRY} in ~/.npmrc. Add:\n  //registry.npmjs.org/:_authToken=<your-token>`);
  }
  console.log(`[publish-scoped] npm token present in ~/.npmrc (value not read)`);

  const pVersion = providerVersion();
  if (pVersion !== version) {
    fail(`version drift: package.json=${version}, PROVIDER_VERSION=${pVersion}`);
  }
  console.log(`[publish-scoped] version consistent: ${version}`);

  const dirty = run("git", ["status", "--porcelain"], { capture: true });
  if (dirty) fail(`working tree is not clean:\n${dirty}`);
  console.log(`[publish-scoped] working tree clean`);

  // Credential guard + build, same lifecycle steps npm publish would run.
  console.log(`[publish-scoped] running credential guard...`);
  run(NPM, ["run", "prepublishOnly"]);

  const meta = await registryMeta();
  if (!meta) fail("cannot reach npm registry metadata");
  if (meta.versions?.[version]) {
    if (dryRun) {
      console.warn(`[publish-scoped] WARNING: ${version} is already published; a real run would refuse it.`);
    } else {
      fail(`${PACKAGE}@${version} already exists on npm — bump the version instead`);
    }
  } else {
    console.log(`[publish-scoped] ${version} not yet published; current ${tag} = ${meta["dist-tags"]?.[tag]}`);
  }

  if (dryRun) {
    console.log(`[publish-scoped] DRY RUN — would execute:`);
    console.log(`  npm publish --access public --tag ${tag} --registry ${REGISTRY}`);
    return;
  }

  console.log(`[publish-scoped] publishing ${PACKAGE}@${version} under ${tag}...`);
  run(NPM, ["publish", "--access", "public", "--tag", tag, "--registry", REGISTRY]);

  // Bounded propagation check via the raw registry (cache-busted). npm's
  // metadata can take a few minutes to reach every edge.
  const deadline = Date.now() + PROPAGATION_TIMEOUT_MS;
  let published = false;
  while (Date.now() < deadline) {
    const after = await registryMeta();
    if (after?.versions?.[version] && after["dist-tags"]?.[tag] === version) {
      published = true;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  // The cached packument can lag behind a successful upload. Before declaring
  // failure, ask npm directly with --prefer-online: if the tag resolves to our
  // version there, the publish landed and it was only a propagation delay.
  if (!published) {
    console.log(`[publish-scoped] raw registry did not show ${tag} -> ${version} within ${PROPAGATION_TIMEOUT_MS / 1000}s; rechecking with npm --prefer-online...`);
    if (npmViewTag(tag) === version) {
      published = true;
    }
  }
  if (!published) {
    fail(`upload returned success but ${tag} did not reach ${version} within ${PROPAGATION_TIMEOUT_MS / 1000}s, and npm --prefer-online disagreed. Check: npm view ${PACKAGE}@${tag} --registry ${REGISTRY} --prefer-online`);
  }
  console.log(`[publish-scoped] verified: ${tag} -> ${version} on ${REGISTRY}`);
}

await main();
