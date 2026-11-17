import { describe, it, expect } from "vitest"
import { createStallWatchdog } from "../scripts/panini-stall-watchdog.mjs"

// The watchdog's job is a DISCRIMINATION: a hung runner vs a sleeping PC (2026-10-03, the 10:00 AM
// PT walk went silent after its walk-order read and the server could not tell which). Each verdict
// is pinned with the other as its control.

function clock(start = 0) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}
const MIN = 60_000

describe("panini stall watchdog", () => {
  it("is silent while progress keeps arriving (no-change control)", () => {
    const c = clock()
    const w = createStallWatchdog({ now: c.now, idleLimitMs: 15 * MIN, sleepGapMs: 5 * MIN })
    for (let i = 0; i < 120; i++) {
      c.advance(MIN)
      if (i % 5 === 0) w.mark("walk", `${i}/900`)
      expect(w.check()).toBeNull()
    }
  })

  it("STALL: ticks on time, no progress past the limit -> names the last phase", () => {
    const c = clock()
    const w = createStallWatchdog({ now: c.now, idleLimitMs: 15 * MIN, sleepGapMs: 5 * MIN })
    w.mark("enum", "Basketball")
    let v = null
    for (let i = 0; i < 16 && !v; i++) { c.advance(MIN); v = w.check() }
    expect(v).toEqual({ kind: "stall", phase: "enum", detail: "Basketball", idle_min: 16 })
  })

  it("does NOT call a stall at exactly the limit (boundary)", () => {
    const c = clock()
    const w = createStallWatchdog({ now: c.now, idleLimitMs: 15 * MIN, sleepGapMs: 5 * MIN })
    for (let i = 0; i < 15; i++) { c.advance(MIN); expect(w.check()).toBeNull() }
  })

  it("SLEPT: one long gap between ticks is the machine, not a hang — and it resets the idle clock", () => {
    const c = clock()
    const w = createStallWatchdog({ now: c.now, idleLimitMs: 15 * MIN, sleepGapMs: 5 * MIN })
    w.mark("walk", "120/900")
    c.advance(47 * MIN) // asleep: no tick fired for 47 min, far past the 15 min idle limit
    expect(w.check()).toEqual({ kind: "slept", phase: "walk", detail: "120/900", gap_min: 47 })
    // Awake again and progressing: not reported as a stall on the next tick.
    c.advance(MIN)
    expect(w.check()).toBeNull()
  })

  it("after a sleep, a run that STILL makes no progress is a stall (sleep does not excuse a hang)", () => {
    const c = clock()
    const w = createStallWatchdog({ now: c.now, idleLimitMs: 15 * MIN, sleepGapMs: 5 * MIN })
    c.advance(30 * MIN)
    expect(w.check()?.kind).toBe("slept")
    let v = null
    for (let i = 0; i < 16 && !v; i++) { c.advance(MIN); v = w.check() }
    expect(v?.kind).toBe("stall")
  })
})
