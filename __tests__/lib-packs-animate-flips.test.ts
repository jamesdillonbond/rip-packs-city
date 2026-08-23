// The pack simulator's flip animation, and the cancellation it shipped without.
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// The loop this replaces ran up to `rips × slots` iterations at 70 ms with NO
// mounted check, so navigating away mid-rip left it setting state on a tree that
// was gone.
//
// ⚠ IT DOES NOT THROW IN A BROWSER, which is why it survived: React drops an
// update to an unmounted component, so the only cost is invisible wasted work.
// Under vitest it landed after jsdom tore `window` down and surfaced as an
// UNHANDLED REJECTION (`ReferenceError: window is not defined`) that failed
// `npm test` while every test passed and NO test name appeared — the failure
// pointed at no file, and vitest's own note said the error had merely
// "originated in" an unrelated spec.
//
// ⚠ A CANCELLATION CHECK IS INVISIBLE WHEN IT WORKS. Nothing goes red if the
// next cleanup deletes it, which is the whole argument for pinning it rather
// than trusting review — and for putting it in `lib/`, since `app/**/*.tsx` is
// measured by neither coverage gate.
//
// ⚠ The assertions below use an INJECTED `wait`, not fake timers. The property
// is "it stops", and a test that advanced timers manually would be asserting the
// harness rather than the loop.

import { describe, it, expect, vi } from "vitest"
import { animateFlips } from "@/lib/packs/animate-flips"

/** Resolves immediately, so a full run costs no real time. */
const instant = () => Promise.resolve()

describe("animateFlips", () => {
  it("delivers every tick while it stays alive", async () => {
    const onTick = vi.fn()

    const delivered = await animateFlips({
      count: 5,
      delayMs: 70,
      onTick,
      isAlive: () => true,
      wait: instant,
    })

    expect(delivered).toBe(5)
    expect(onTick).toHaveBeenCalledTimes(5)
  })

  it("STOPS the moment it is no longer alive, mid-run", async () => {
    // ⚠ THE REGRESSION FLOOR. Alive for the first two flips, dead after — which
    // is the unmount-mid-animation case. Without the check the loop runs all ten.
    let ticks = 0
    const onTick = vi.fn(() => {
      ticks++
    })

    const delivered = await animateFlips({
      count: 10,
      delayMs: 70,
      onTick,
      isAlive: () => ticks < 2,
      wait: instant,
    })

    expect(delivered, "must stop at the flip where it died").toBe(2)
    expect(onTick).toHaveBeenCalledTimes(2)
    // Assert the ABSENCE of the defect, not just a smaller number: the point is
    // that the remaining eight never ran at all.
    expect(onTick).not.toHaveBeenCalledTimes(10)
  })

  it("delivers NOTHING when it is already dead", async () => {
    const onTick = vi.fn()

    const delivered = await animateFlips({
      count: 4,
      delayMs: 70,
      onTick,
      isAlive: () => false,
      wait: instant,
    })

    expect(delivered).toBe(0)
    expect(onTick).not.toHaveBeenCalled()
  })

  it("checks liveness AFTER the delay, not before it", async () => {
    // ⚠ The ordering is the property. The gap between scheduling a flip and it
    // firing is the entire window in which an unmount happens — a check that ran
    // at the TOP of the iteration would pass and then tick into a dead tree
    // anyway. Here `isAlive` only goes false DURING the first wait, so a
    // check-before implementation delivers one tick and this reds.
    let dead = false
    const onTick = vi.fn()

    const delivered = await animateFlips({
      count: 3,
      delayMs: 70,
      onTick,
      isAlive: () => !dead,
      wait: async () => {
        dead = true
      },
    })

    expect(delivered, "a check placed before the delay would deliver 1").toBe(0)
    expect(onTick).not.toHaveBeenCalled()
  })

  it("waits before every flip, with the delay it was given", async () => {
    // Without this a "fix" that skipped the wait entirely would satisfy every
    // assertion above while removing the animation.
    const waits: number[] = []
    const onTick = vi.fn()

    await animateFlips({
      count: 3,
      delayMs: 70,
      onTick,
      isAlive: () => true,
      wait: async (ms) => {
        waits.push(ms)
      },
    })

    expect(waits).toEqual([70, 70, 70])
  })

  it("a zero count is a no-op, not an error", async () => {
    const onTick = vi.fn()
    const delivered = await animateFlips({
      count: 0,
      delayMs: 70,
      onTick,
      isAlive: () => true,
      wait: instant,
    })

    expect(delivered).toBe(0)
    expect(onTick).not.toHaveBeenCalled()
  })
})
