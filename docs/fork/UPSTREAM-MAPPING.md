# Fork Surface Map — scoped hermes fork

Direction: **fork the boundary, not the engine.**

This file is the source of truth for what this fork is allowed to change, and
the evidence for each divergence. Discipline ported from `njuptlzf/mcp-adapter`
(`MAPPING.md` + `scripts/upstream-divergence.ts`), with one documented
difference — see §5, it matters.

Baseline: `chandra447/pi-hermes-memory` **v0.11.0** (`ccdae89`).
Fork tag tracks upstream: `hermes-0.11.0-scoped.<n>`.

Numbers below were measured, not estimated: `AGENT_ROOT` has **27 references
across 11 files** (1 definition + 10 consumers), and `src/` is **18,253 lines
across 56 files** — so the fork touches ~11 of 56 source files and **zero lines
of the store/retrieval engine**.

---

## 1. Fork-owned files (can never conflict on merge)

| File | Purpose | Conflicts? |
| --- | --- | --- |
| `docs/fork/UPSTREAM-MAPPING.md` | this map | no — fork-only path |
| `docs/fork/divergences.json` | registry read by the gate | no — fork-only path |
| `scripts/upstream-divergence.mjs` | `npm run upstream:check` | no — fork-only path |

Anything added under `docs/fork/` or as a new `scripts/*.mjs` is fork-owned by
definition: upstream does not know the path, so a merge never touches it.

## 2. Diverged upstream files — the entire merge surface

`refs` = `AGENT_ROOT` reference count in that file. `risk` is the merge-conflict
class the change creates, using the taxonomy from mcp-adapter's
`docs/upstream-merge-retrospective.md` (import conflicts resolve mechanically;
same-function-body conflicts do not).

| File | refs | Change | risk | Upstream anchors (evidence) |
| --- | --- | --- | --- | --- |
| `src/paths.ts` | 4 | `AGENT_ROOT` splits into `storageRoot` (injected, per scope) and `runtimeRoot` (global) | edit | `AGENT_ROOT` defined at `paths.ts:5`; consumers `resolveProjectsRoot`, `normalizeProjectsMemoryDir` |
| `src/config.ts` | 2 | carry injected root; no env/cwd discovery for memory | edit | `AGENT_ROOT` |
| `src/index.ts` | 2 | wrap the default export in `createScopedHermesMemory({ storageRoot })` | **wrap** (body untouched) | `export default function (pi: ExtensionAPI)` — 481-line file |
| `src/handlers/index-sessions.ts` | 3 | `SESSIONS_DIR` (import-time const) becomes lazy | edit | `SESSIONS_DIR` at line 14; used at lines 43, 56 |
| `src/tools/session-search-tool.ts` | 2 | `DEFAULT_SESSIONS_DIR` (import-time const) becomes lazy | edit | `DEFAULT_SESSIONS_DIR` at line 30; `options.sessionsDir` override exists at line 59 |
| `src/handlers/sync-markdown-memories.ts` | 4 | root parameter | edit | densest consumer after `paths.ts` |
| `src/handlers/auto-consolidate.ts` | 2 | consolidation lock derived from injected root | edit | shares today's global lock across scopes |
| `src/handlers/pi-child-process.ts` | 3 | keep runtime discovery global (line 239) | edit | `AGENT_ROOT` doubles as pi module-discovery root |
| `src/store/skill-store.ts` | 2 | root threaded in | edit | bypasses config today |
| `src/store/recovery-maintenance.ts` | 1 | root parameter | edit | 1 reference |
| `src/constants.ts` | 0 | `buildMemoryTargetRoutingGuidance()` (line 230) rewritten to scope-relative wording | edit | the only prompt-side change; callers in `background-review.ts`, `correction-detector.ts` pass a boolean |

## 3. Deliberately untouched (and the reason it stays that way)

| Area | File(s) | Size | Why untouched | Conflict exposure |
| --- | --- | --- | --- | --- |
| Store engine | `src/store/memory-store.ts` | 1,309 lines | already honours `config.memoryDir` (`memory-store.ts:91`) — scope arrives through config, not through code | **zero hunks = clean merge**, even if upstream rewrites it |
| SQLite layer | `src/store/db.ts`, `sqlite-memory-store.ts`, `session-indexer.ts` | 1,227 + 1,262 + 730 | reads its directory from the store | none while untouched |
| Consolidation | `src/handlers/review-memory-ops.ts`, `skills-command.ts` | 996 + 1,334 | operates on whatever store it is handed | none |
| Retrieval / hybrid search | `src/store/session-anchor-search.ts` and friends | 472 | this fork exists to *keep* upstream's retrieval, not replace it | none |

Rule of thumb: **if a change can be expressed as an injected parameter or a
config value, it is not an engine change.** Every entry in §2 qualifies; none of
the entries in §3 do.

## 4. Upstream update checklist

Run these on every upstream release, in order:

1. `git fetch upstream --tags`
2. `npm run upstream:check` — read the four categories:
   - **unregistered** → we diverged without declaring it; declare or revert.
   - **stale** → upstream absorbed our change (or we lost it); re-probe the
     upstream file before flipping the entry back to `planned`.
   - **moved-upstream** → our declared file changed under us; this is the
     merge-conflict surface for the next drill, read it before merging.
3. For each `moved-upstream` row: `git diff <old-blob>..<new-blob> -- <file>` and
   re-check the anchors listed in §2 (symbol renamed? line moved? constant
   became a parameter upstream — the best outcome, delete our entry).
4. Merge on a `upstream-merge/<version>` branch, never on `main`.
5. `npm test` (60 test files) + `npx tsc --noEmit`; a merge that typechecks but
   drops tests is not a merge.
6. Re-pin `upstreamBaseline` / `baselineCommit` / every `baseBlob` in
   `docs/fork/divergences.json`, bump the fork tag.

## 5. Why this gate is blocking (the delta from mcp-adapter)

mcp-adapter can claim "the engine is untouched" **structurally**: its engine
runs against a host *type* (`UniversalHostSurface` impersonates `ExtensionAPI`),
so a re-introduced coupling fails to compile. Its `check-pi-coupling.yml` is
therefore *advisory* (every branch ends in `exit 0`) — the compiler is the real
gate.

A hermes fork has no such barrier. The engine **must** diverge in 11 files, and
nothing in the type system fails when a twelfth edit slips in. So the two halves
of the discipline do not transfer equally:

- the **registry + evidence table** transfer as-is;
- the **advisory verdict does not** — `scripts/upstream-divergence.mjs` exits `1`
  on unregistered/stale rows by design. An advisory guard on a fork with no
  type boundary is a comment, not a control.

What still cannot be automated, and must be caught in review: a *wrong* change
inside a declared file. The gate proves "only declared files diverged"; it
cannot prove "the declared change is correct". That is what the test suite and
the merge drill are for.

---

## 6. Host wiring — agent-chat behind a memory-provider port

agent-chat does not hardcode any memory plugin. It defines a port
(`packages/protocol/src/memory-provider.ts`) and resolves an id from the
product manifest (`agent.memory: { provider: "hermes-scoped" }`). The fork's
job is therefore not "be drop-in compatible with scopedMemory" but "satisfy the
port", which is a smaller and more stable obligation:

```ts
// packages/server/src/memory-providers.ts (host side)
const tenant = openScopedHermesMemory({ storageRoot: ctx.storageRoot });
return {
  providerId: "hermes-scoped",
  selfInjects: false,           // the host owns prompt assembly
  factory: (pi) => tenant.mount(pi),
  promptSection: () => tenant.promptSection(),
  erase: () => tenant.erase(),
  dispose: () => tenant.dispose(),
};
```

Three consequences, each of which changed this fork's shape:

1. **`open()` and `mount()` are separate.** The host needs the prompt section
   while it builds `DefaultResourceLoader`, before any pi session exists.
   `openScopedHermesMemory(options)` therefore returns the tenant (store,
   `promptSection`, `erase`, `dispose`) and `handle.mount(pi)` attaches tools
   and hooks. `createScopedHermesMemory` remains as the one-call convenience.
2. **`selfInjects: false` is the correct answer here.** Upstream hermes appends
   its own section in `before_agent_start`; in a server that assembles the
   prompt, that is the wrong owner — and it silently does nothing whenever the
   host skips `bindExtensions`. The port forces the decision to be explicit, and
   the fork exposes `promptSection()` from the same builder the hook uses, so
   the two routes cannot drift.
3. **Admission still applies.** `extension-admission.ts` scans the declared
   extension file for `process.env`, `os.homedir()`, `child_process` and TUI
   registrations. The scoped entry passes ②③④; ① (default export) belongs to
   the adapter the host declares, not to this module.

Erasure is part of the port, so it had to become a first-class call:
`handle.erase()` closes the tenant's lock database and removes exactly the
tenant root. `tests/scoped/multi-tenant.test.ts` asserts the deletion succeeds
and that a neighbouring tenant's file survives.

### Diff counters after this slice

| Counter | Value |
| --- | --- |
| Upstream files modified | 3 (`package.json`, `src/config.ts`, `src/store/atomic-lock-coordinator.ts`) |
| Fork-owned files added | 10 |
| Engine files whose **existing** lines changed | 0 — all three edits are additions |
| Hunks inside functions upstream edits | 0 |

---

## 7. Packaging: the host consumes an npm package, not a source link

The host depends on a package, so the fork has to be consumable without a
TypeScript loader in the host's build. Three changes, all fork-owned:

| Change | Why |
| --- | --- |
| package name → `@njuptlzf/pi-hermes-memory` | the unscoped `pi-hermes-memory` on npm is upstream's; a fork publishing under it would either fail or shadow it |
| `exports` becomes conditional: `agent-chat-source` → `src/*.ts`, `default` → `dist/*.js` | matches the host repo's own convention: their tsc resolves source, their runtime loads `dist` |
| `build` / `prepack` scripts (`tsc -p tsconfig.json`) | `dist` is a build artifact, so it is produced at pack time and never committed (`dist/` stays gitignored) |

Verified end to end without a registry account, using the same code path a
registry install uses:

```bash
npm pack                        # -> njuptlzf-pi-hermes-memory-0.11.0-scoped.1.tgz
cd /tmp/npm-consumer && npm install /path/to/that.tgz
node -e "import('@njuptlzf/pi-hermes-memory/scoped-provider').then(m => m.default.open({ storageRoot }))"
# -> hermes-scoped 0.11.0-scoped.1, selfInjects: false, section 4114 chars, erase: true
```

That run used plain `node`, no `tsx`, no TypeScript in the host — which is the
actual requirement. Publishing itself is the only remaining step and it is not
a code change: `.github/workflows/publish.yml` already publishes on tag via OIDC
trusted publishing, so a tag from this fork publishes the scoped name.

Version discipline: `PROVIDER_VERSION` in `src/scoped/provider.ts` must equal
`package.json`'s `version`, and `tests/scoped/provider.test.ts` asserts it. A
release that bumps one and forgets the other makes the host report the wrong
engine version in its own logs, which is worse than not reporting one.

The host then declares it from the product side — no server code, one line of
manifest plus a three-line adapter file:

```yaml
agent:
  memory:
    provider: hermes-scoped
  memoryProviders:
    - ./memory/hermes-scoped.ts     # file inside the product dir, or a package specifier
```

## Diff counters after this slice

| Counter | Value |
| --- | --- |
| Upstream files modified | 3 (`package.json`, `src/config.ts`, `src/store/atomic-lock-coordinator.ts`) |
| Fork-owned files added | 12 |
| Engine files whose **existing** lines changed | 0 — all edits are additions |
| Hunks inside functions upstream edits | 0 |
