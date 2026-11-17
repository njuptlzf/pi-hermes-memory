/**
 * Root algebra for the scoped (multi-tenant) entry.
 *
 * Deliberately pure: no `process.env`, no `os.homedir()`, no `path.resolve`
 * against an implicit base. The host owns identity and computes both roots —
 * this module only validates them and derives the layout.
 *
 * Why the split matters (see docs/fork/UPSTREAM-MAPPING.md §2): in upstream,
 * `AGENT_ROOT` is two things at once — the memory storage root and the pi
 * runtime module-discovery root. Scoping the second one breaks pi for every
 * session in the process, so they are separate values here, and `runtimeRoot`
 * is optional: omitting it disables the features that need a pi-owned
 * directory (session indexing) instead of silently falling back to a global.
 */

import * as path from "node:path";

export interface ScopedRootInput {
  /**
   * Per-tenant memory root. Absolute path, computed by the host — e.g.
   * `<dataDir>/memory/<userId>/<scope>`. Everything this tenant writes lives
   * underneath it, so a single recursive delete erases exactly one tenant.
   */
  readonly storageRoot: string;
  /**
   * Global pi runtime root (sessions, pi-installed skills). Absolute, shared
   * across tenants on purpose. Omit it when the host does not have one.
   */
  readonly runtimeRoot?: string | null;
  /**
   * Cross-scope user root, absolute, shared by every scope of ONE user —
   * e.g. `<dataDir>/memory/<userId>/profile`.
   *
   * Deliberately a separate root and not a subdirectory of `storageRoot`: the two
   * have different erasure semantics. `storageRoot` dies with the scope, this one
   * only dies when the *user* is deleted. Putting the profile inside the scope
   * would make "erase this qualification" silently erase the user's identity.
   *
   * Omit it and the tenant is scope-only: no cross-scope profile, nothing shared.
   */
  readonly sharedRoot?: string | null;
}

export interface ScopedRoots {
  readonly storageRoot: string;
  readonly runtimeRoot: string | null;
  readonly sharedRoot: string | null;
}

export interface ScopedLayout {
  /** `MEMORY.md` / `USER.md` / `failures.md` live here. */
  readonly memoryDir: string;
  /** Generated procedural skills for this tenant. */
  readonly skillsDir: string;
  /** `<storageRoot>/projects/<slug>/` — per-project stores inside the tenant. */
  readonly projectsRoot: string;
  /** `<sharedRoot>/profile/` — the cross-scope user profile, or null when scope-only. */
  readonly profileDir: string | null;
  /** Pinned standing instructions file. */
  readonly standingFile: string;
  /** Session index database for this tenant, or null without a runtime root. */
  readonly sessionsDbPath: string | null;
}

/** Marker appended to every error this module throws, so hosts can classify it. */
export const SCOPED_ROOT_ERROR = "SCOPED_ROOT_INVALID";

function assertAbsolute(input: unknown, field: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error(`${SCOPED_ROOT_ERROR}: \`${field}\` must be a non-empty string`);
  }
  // NUL truncates paths in native calls; reject rather than let it through.
  if (input.includes("\0")) {
    throw new Error(`${SCOPED_ROOT_ERROR}: \`${field}\` contains a NUL byte`);
  }
  if (!path.isAbsolute(input)) {
    throw new Error(
      `${SCOPED_ROOT_ERROR}: \`${field}\` must be an absolute path (got "${input}") — ` +
        "the host computes it, this module never resolves against a process default",
    );
  }
  const normalized = path.normalize(input);
  // Refuse the filesystem root itself: every tenant sharing "/" is the bug this
  // entry exists to prevent, and `rm -rf` on erasure would be catastrophic.
  if (path.parse(normalized).root === normalized) {
    throw new Error(`${SCOPED_ROOT_ERROR}: \`${field}\` must not be the filesystem root`);
  }
  return normalized;
}

/**
 * Validate and normalize the two roots.
 *
 * `storageRoot` is required and must be absolute and tenant-specific.
 * `runtimeRoot` is optional; when present it must only be absolute — it is
 * shared by design, so no tenant check applies to it.
 */
export function resolveScopedRoots(input: ScopedRootInput): ScopedRoots {
  const storageRoot = assertAbsolute(input.storageRoot, "storageRoot");
  const runtimeRoot = input.runtimeRoot === undefined || input.runtimeRoot === null
    ? null
    : assertAbsolute(input.runtimeRoot, "runtimeRoot");
  const sharedRoot = input.sharedRoot === undefined || input.sharedRoot === null
    ? null
    : assertAbsolute(input.sharedRoot, "sharedRoot");

  if (sharedRoot !== null) {
    // Overlapping roots make erasure ambiguous: "delete this scope" would take a
    // slice out of the shared profile, or "delete the user" would miss data that
    // happens to live under a scope. Keep them disjoint in both directions.
    if (isInsideRoot(sharedRoot, storageRoot) || isInsideRoot(storageRoot, sharedRoot)) {
      throw new Error(
        `${SCOPED_ROOT_ERROR}: \`sharedRoot\` and \`storageRoot\` must not overlap ` +
          `(shared=${sharedRoot}, scope=${storageRoot}) — erasure of one would corrupt the other`,
      );
    }
  }

  return { storageRoot, runtimeRoot, sharedRoot };
}

/**
 * Derive the paths a tenant uses. Pure: same roots in, same layout out.
 */
export function scopedLayout(roots: ScopedRoots): ScopedLayout {
  const memoryDir = path.join(roots.storageRoot, "memory");
  return {
    memoryDir,
    skillsDir: path.join(memoryDir, "skills"),
    projectsRoot: path.join(memoryDir, "projects"),
    profileDir: roots.sharedRoot === null ? null : path.join(roots.sharedRoot, "profile"),
    standingFile: "STANDING.md",
    sessionsDbPath: roots.runtimeRoot === null ? null : path.join(roots.runtimeRoot, "sessions"),
  };
}

/**
 * True when `candidate` (absolute) is inside `root` (absolute).
 *
 * Used by the erasure and inspection paths so a host cannot be talked into
 * deleting a directory outside the tenant by a crafted scope name.
 */
export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
