/**
 * Idempotent injection of the scoped provider's own prompt blocks.
 *
 * A host with `selfInjects: false` is expected to pre-inject `promptSection()`
 * into its own prompt before the extension mounts (agent-chat does exactly
 * that). The scoped entry also appends the section from `before_agent_start`,
 * because a host that binds no extensions must still get the policy. Both
 * routes fire on the agent-chat path, so appending blindly yields two copies —
 * and after a mid-session profile correction the two disagree (see
 * docs/fork/P5-STANDING-DESIGN.md §4.4).
 *
 * Removing our own blocks first makes the operation idempotent AND keeps the
 * content fresh, without having to remember what we emitted last turn. The tag
 * namespaces below are emitted only by this provider:
 *   <memory-policy>            src/scoped/policy.ts:35,88
 *   <user-profile …>           src/scoped/entry.ts:286
 *   <standing-instructions>    src/store/standing-instructions.ts:175,190
 *
 * Fork-owned. Upstream tool/store files stay untouched.
 */

const OWNED_BLOCKS = [
  /<memory-policy>[\s\S]*?<\/memory-policy>/g,
  /<user-profile\b[^>]*>[\s\S]*?<\/user-profile>/g,
  /<standing-instructions>[\s\S]*?<\/standing-instructions>/g,
] as const;

/**
 * Strip this provider's blocks from `current`, then append `fresh` last.
 *
 * The blank-run collapse after stripping deliberately runs over the whole
 * remainder rather than widening the block patterns with `\n*`: widening them
 * glues a host's neighbouring sections together (`</tools><cwd>`), which is a
 * worse bug than one extra blank line.
 */
export function replaceOwnedBlocks(current: string, fresh: string): string {
  let rest = current;
  for (const pattern of OWNED_BLOCKS) rest = rest.replace(pattern, "");
  rest = rest.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n").trim();
  return rest === "" ? fresh : `${rest}\n\n${fresh}`;
}
