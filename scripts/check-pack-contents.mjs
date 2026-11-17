#!/usr/bin/env node
/**
 * Fail before a publish if a credential-shaped file would ship in the tarball.
 *
 * Why not `.npmignore`: when `files` is present in package.json, npm ignores
 * `.npmignore` entirely — verified against npm 10.9.7, where a token file under
 * `dist/` was listed by `npm pack --dry-run` with a `.npmignore` naming it. So the
 * guard has to run as a lifecycle step, not as a config file.
 *
 * Runs on `prepublishOnly` (before `prepack` builds, so no recursion — calling
 * `npm pack` from inside `prepack` would re-enter it).
 *
 * The check prints the offending *path*, never the content.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Directories that can end up in the tarball (mirrors package.json `files`). */
const SCAN_DIRS = ["src", "dist", "scripts", "docs"];

/** Names that are credentials, not code. Deliberately broad: a false positive
 *  costs one rename, a false negative costs a leaked token on a public registry. */
const DENY = [
  /(^|[/\\])\.npmrc$/i,
  /(^|[/\\])\.env(\.|$)/i,
  /(^|[/\\])id_(rsa|ed25519|ecdsa)$/i,
  /\.(pem|key|p12|pfx)$/i,
  /token/i,
  /credential/i,
  /secret/i,
];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // Directory absent is fine: dist only exists after a build.
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const offenders = [];
for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir), [])) {
    const rel = relative(ROOT, file);
    if (DENY.some((pattern) => pattern.test(rel))) {
      offenders.push({ path: rel, size: statSync(file).size });
    }
  }
}

if (offenders.length > 0) {
  console.error("[check-pack-contents] refusing to publish: credential-shaped file(s) would ship:");
  for (const { path, size } of offenders) console.error(`  - ${path} (${size} bytes)`);
  console.error(
    "[check-pack-contents] move them outside the package tree (or out of `files`), then retry. "
      + "`.npmignore` does not help here: npm ignores it when `files` is set.",
  );
  process.exit(1);
}

console.log("[check-pack-contents] clean: no credential-shaped files under " + SCAN_DIRS.join(", "));
