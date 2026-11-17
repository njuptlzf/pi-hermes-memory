#!/usr/bin/env node
/**
 * upstream-divergence.mjs — fork-delta ↔ upstream-surface guard.
 *
 * Discipline ported from njuptlzf/mcp-adapter (MAPPING.md + scripts/upstream-divergence.ts),
 * with one deliberate change: this check is BLOCKING. Upstream's own
 * check-pi-coupling.yml is advisory-only (every branch ends in `exit 0`), which is
 * exactly how a fork rots silently — it reports forever and never stops a merge.
 *
 * Categories, per file observed in `git diff <base>`:
 *   registered   — declared in docs/fork/divergences.json (status planned|applied)
 *   unregistered — we diverge from upstream without a declaration          -> FAIL
 *   stale        — declared `applied` but no longer diverged (upstream
 *                  absorbed it, or the change was lost)                    -> FAIL
 *   moved        — declared file whose *upstream* blob changed since the
 *                  pinned baseline (merge-conflict risk, not an error)     -> WARN
 *
 * Exit codes: 0 clean | 1 unregistered/stale (or moved under --strict) | 2 fatal.
 *
 * Flags: --base <ref> (default upstream/main), --json, --no-fetch, --strict,
 *        --no-color, --color.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY_PATH = resolve(ROOT, "docs/fork/divergences.json");
const LOG = "[upstream-divergence]";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : fallback;
};

const baseRef = option("--base", "upstream/main");
const jsonMode = flag("--json");
const doFetch = !flag("--no-fetch");
const strict = flag("--strict");
const useColor = !flag("--no-color") && (flag("--color") || process.stdout.isTTY === true);
const paint = useColor
  ? { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", reset: "\x1b[0m" }
  : { green: "", yellow: "", red: "", dim: "", reset: "" };

function git(args) {
  return execFileSync("git", ["-C", ROOT, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function fatal(message) {
  console.error(`${LOG} FATAL: ${message}`);
  process.exit(2);
}

function normalizePath(p) {
  return p.replace(/\\/g, "/").trim();
}

function fetchUpstream() {
  try {
    git(["fetch", "--tags", "upstream"]);
    return true;
  } catch (err) {
    console.error(`${LOG} 'git fetch upstream' failed: ${err.message.split("\n")[0]}`);
    return false;
  }
}

function readRegistry() {
  let raw;
  try {
    raw = readFileSync(REGISTRY_PATH, "utf-8");
  } catch (err) {
    fatal(`registry unreadable at ${REGISTRY_PATH}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fatal(`registry is not valid JSON: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.entries)) {
    fatal("registry must contain an `entries` array");
  }
  for (const [i, entry] of parsed.entries.entries()) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) {
      fatal(`registry entry #${i} is missing a string \`path\``);
    }
    if (entry.status !== "planned" && entry.status !== "applied") {
      fatal(`registry entry ${entry.path} needs status "planned" or "applied"`);
    }
  }
  return parsed;
}

/** @returns {Map<string, string>} path -> status letter (M/A/D/R...) */
function readDivergence() {
  let out;
  let untracked;
  try {
    // Compare the base ref against the working tree (not HEAD) so the gate also
    // sees uncommitted work; untracked files are added separately because git
    // diff never reports them.
    out = git(["diff", "--name-status", baseRef]);
    untracked = git(["ls-files", "--others", "--exclude-standard"]);
  } catch (err) {
    fatal(`'git diff ${baseRef}' failed: ${err.message.split("\n")[0]}`);
  }
  const map = new Map();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = (parts[0] || "").trim().charAt(0);
    // Renames/copies carry two paths; the destination is the one that matters.
    const path = normalizePath(parts.length > 2 ? parts[2] : parts[1] || "");
    if (path) map.set(path, status);
  }
  for (const line of untracked.split("\n")) {
    const path = normalizePath(line);
    if (path && !map.has(path)) map.set(path, "A");
  }
  return map;
}

function upstreamBlob(path) {
  try {
    return git(["rev-parse", `${baseRef}:${path}`]).trim();
  } catch {
    return null; // File does not exist upstream (fork-only addition).
  }
}

function classify(registry, divergence) {
  const declared = new Map(registry.entries.map((e) => [normalizePath(e.path), e]));
  const registered = [];
  const unregistered = [];
  const stale = [];
  const moved = [];

  for (const [path, status] of divergence) {
    const entry = declared.get(path);
    if (!entry) {
      unregistered.push({ path, status });
      continue;
    }
    registered.push({ path, status, entry });
  }

  for (const entry of registry.entries) {
    const path = normalizePath(entry.path);
    if (!divergence.has(path) && entry.status === "applied") stale.push({ path, entry });
  }

  for (const { path, entry } of registered) {
    if (!entry.baseBlob) continue;
    const current = upstreamBlob(path);
    if (current && current !== entry.baseBlob) moved.push({ path, was: entry.baseBlob, now: current });
  }

  return { registered, unregistered, stale, moved };
}

function render(registry, result) {
  const { registered, unregistered, stale, moved } = result;
  const line = (label, rows, color, describe) => {
    if (rows.length === 0) return;
    console.log(`\n${color}${label} (${rows.length})${paint.reset}`);
    for (const row of rows) console.log(`  ${color}-${paint.reset} ${describe(row)}`);
  };

  console.log(`${LOG} base=${baseRef} baseline=${registry.upstreamBaseline ?? "unset"}`);
  console.log(
    `${paint.green}registered${paint.reset} ${registered.length} · ` +
      `${paint.red}unregistered${paint.reset} ${unregistered.length} · ` +
      `${paint.red}stale${paint.reset} ${stale.length} · ` +
      `${paint.yellow}moved-upstream${paint.reset} ${moved.length}`,
  );

  line("REGISTERED", registered, paint.green, (r) => `${r.path} [${r.status}] — ${r.entry.reason ?? ""}`);
  line("UNREGISTERED — declare it in docs/fork/divergences.json or revert it", unregistered, paint.red,
    (r) => `${r.path} [${r.status}]`);
  line("STALE — declared applied, no longer diverged: re-probe upstream, then flip to planned or drop", stale, paint.red,
    (r) => `${r.path} — ${r.entry.reason ?? ""}`);
  line("MOVED UPSTREAM — our declared file changed under us: read the merge drill before the next release", moved, paint.yellow,
    (r) => `${r.path} (${String(r.was).slice(0, 8)} -> ${String(r.now).slice(0, 8)})`);

  if (registered.length + unregistered.length + stale.length + moved.length === 0) {
    console.log(`\n${paint.green}clean: fork tree matches ${baseRef}${paint.reset}`);
  }
}

function main() {
  const registry = readRegistry();
  if (doFetch) fetchUpstream();
  const divergence = readDivergence();
  const result = classify(registry, divergence);

  if (jsonMode) {
    const payload = {
      base: baseRef,
      baseline: registry.upstreamBaseline ?? null,
      registered: result.registered.map((r) => ({ path: r.path, status: r.status, ...r.entry })),
      unregistered: result.unregistered,
      stale: result.stale.map((r) => ({ path: r.path, reason: r.entry.reason ?? null })),
      movedUpstream: result.moved,
      ok: result.unregistered.length === 0 && result.stale.length === 0 && (!strict || result.moved.length === 0),
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    render(registry, result);
  }

  const failed =
    result.unregistered.length > 0 || result.stale.length > 0 || (strict && result.moved.length > 0);
  if (failed) {
    if (!jsonMode) {
      console.error(
        `\n${paint.red}FAIL${paint.reset} — fix the rows above. This gate is blocking on purpose: ` +
          `an advisory guard is how a fork rots (see docs/fork/UPSTREAM-MAPPING.md).`,
      );
    }
    process.exit(1);
  }
}

main();
