/**
 * Single-slot gate shared by the scoped background memory handlers.
 *
 * Correction detection and periodic review both fire on `turn_end`, and both
 * call `runMemoryOps`: read the current memory, await a host completion, then
 * apply operations to the same store. Without a shared slot a correction and a
 * review could overlap, so one operation set would be planned from a stale
 * snapshot and a `replace` from one could clobber the other's write.
 *
 * The holder is deliberately opaque — a handler only needs to know whether it
 * got the slot, not who owns it. `finish()` is valid only after a successful
 * `tryStart()`; callers guarantee that with try/finally.
 */

export interface BackgroundGate {
  /** Claim the slot. false means another background op already holds it. */
  tryStart(): boolean;
  /** Release the slot. Call exactly once after a successful tryStart(). */
  finish(): void;
}

export function createBackgroundGate(): BackgroundGate {
  let taken = false;
  return {
    tryStart() {
      if (taken) return false;
      taken = true;
      return true;
    },
    finish() {
      taken = false;
    },
  };
}
