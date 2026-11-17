// lib/packs/animate-flips.ts
//
// The pack simulator's card-flip animation, extracted from
// `app/(collections)/[collection]/packs/simulator/[distId]/PackSimulatorClient.tsx`.
//
// ── WHY IT MOVED ────────────────────────────────────────────────────────────
// The loop it replaces was:
//
//     for (let i = 0; i < rips.length * slots; i++) {
//       await new Promise((r) => setTimeout(r, 70))
//       setFlipIndex((p) => p + 1)
//     }
//
// ⚠ NOTHING CANCELLED IT. Up to `rips × slots` iterations at 70 ms each, with no
// mounted check, so a collector who starts a 10× rip and navigates away leaves a
// timer chain running for up to `slots × 10 × 70 ms`, setting state on a tree
// that is gone.
//
// ⚠ IN THE BROWSER THAT DOES NOT THROW, WHICH IS EXACTLY WHY IT SURVIVED. React
// drops an update to an unmounted component, so the only cost is wasted work —
// invisible. Under vitest it landed after jsdom had torn `window` down and
// surfaced as `ReferenceError: window is not defined`, an UNHANDLED REJECTION
// that failed `npm test` while every test passed and no test name appeared.
//
// ⚠ AND IT MOVED TO `lib/` RATHER THAN BEING FIXED IN PLACE because
// `app/**/*.tsx` is measured by NEITHER coverage gate. A cancellation check is
// invisible when it works — the next cleanup deletes it and nothing goes red —
// so it needs a test, and it can only have one here.

export interface AnimateFlipsOptions {
  /** How many flips to step through. */
  count: number
  /** Delay before each flip. */
  delayMs: number
  /** Called once per flip, after its delay. */
  onTick: () => void
  /**
   * Checked AFTER each delay and before `onTick`.
   *
   * ⚠ After, not before: the gap between scheduling and firing is the whole
   * window in which an unmount happens. A check that only ran at the top of the
   * iteration would pass and then tick into a dead tree anyway.
   */
  isAlive: () => boolean
  /** Injectable for tests; defaults to the real timer. */
  wait?: (ms: number) => Promise<void>
}

/**
 * Step `count` flips, stopping early the moment `isAlive()` goes false.
 *
 * Resolves with the number of ticks actually delivered — which is what lets a
 * test tell "it stopped" from "it never started".
 */
export async function animateFlips({
  count,
  delayMs,
  onTick,
  isAlive,
  wait = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
}: AnimateFlipsOptions): Promise<number> {
  let delivered = 0
  for (let i = 0; i < count; i++) {
    await wait(delayMs)
    if (!isAlive()) return delivered
    onTick()
    delivered++
  }
  return delivered
}
