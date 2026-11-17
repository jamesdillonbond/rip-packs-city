import { describe, it, expect } from "vitest"
import { summariseZeroYield } from "@/lib/sentinel/zero-yield"

/**
 * The fourth lane state: ran, succeeded, found NOTHING — for days. Invisible to
 * `Pipeline Silence` (it is ticking) and to `Pipeline Success` (it is green).
 * `laliga_golazos` listings went 7+ days stale behind ~670 clean-reported runs
 * that way (#78), with every instrument OK.
 *
 * ⚠ The two properties that make this arm worth having, both pinned below:
 *   1. it reports the POPULATION it inspected, so a run that inspected nothing
 *      cannot read as a run that found nothing — this repo has shipped a guard
 *      that walked an empty tree and exited 0;
 *   2. it reports what it SUPPRESSED, so the curated half of the guard cannot
 *      quietly grow until the guard means nothing.
 */

const payload = (over: Record<string, unknown> = {}) => ({
  inspected: 243,
  suppressed: 0,
  window: { baseline_days: 30, zero_days: 7, min_runs: 50 },
  offenders: [],
  ...over,
})

describe("summariseZeroYield", () => {
  it("is ok when nothing has fallen to zero, and still states the population", () => {
    const v = summariseZeroYield(payload())
    expect(v.status).toBe("ok")
    expect(v.detail).toMatch(/243 lanes inspected/)
    // The window is part of the claim: "no lane fell to zero" means nothing
    // without the window it was measured over.
    expect(v.detail).toMatch(/7d zero \/ 30d baseline/)
  })

  it("reproduces the live finding and WARNS, naming the lanes", () => {
    const v = summariseZeroYield(
      payload({
        offenders: [
          { pipeline: "sales-counterparty-backfill", runs_recent: 2018, last_find: "2026-09-03" },
          { pipeline: "golazos-listings-indexer", runs_recent: 632, last_find: "2026-09-03" },
          { pipeline: "offers-sweep", runs_recent: 225, last_find: "2026-08-28" },
        ],
      }),
    )
    expect(v.status).toBe("warn")
    expect(v.detail).toMatch(/golazos-listings-indexer/)
    expect(v.detail).toMatch(/last find 2026-08-28/)
    expect(v.detail).toMatch(/3 lane\(s\)/)
  })

  it("does NOT page — these are candidates, not confirmed defects", () => {
    // Two of the first five live hits are named *backfill, and a finished
    // backfill's zero is correct. Spending CRITICAL on that would train the
    // reader to ignore the loudest signal the estate has.
    const v = summariseZeroYield(payload({ offenders: [{ pipeline: "x", runs_recent: 99 }] }))
    expect(v.status).not.toBe("critical")
  })

  it("refuses to call an EMPTY inspection a clean one", () => {
    // The failure this repo keeps repeating: a guard whose population went to
    // zero reads exactly like a guard that found nothing wrong.
    for (const bad of [payload({ inspected: 0 }), payload({ inspected: null }), payload({ inspected: "243" })]) {
      const v = summariseZeroYield(bad as never)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/not a verdict/)
    }
  })

  it("treats an unreadable payload as unmeasured, never as clean", () => {
    for (const bad of [null, undefined, "nope" as never, 42 as never]) {
      const v = summariseZeroYield(bad as never)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED|not a verdict/)
    }
  })

  it("reports how many lanes were SUPPRESSED, so the curated half stays visible", () => {
    // A guard that hides what it excluded makes its own incidence unmeasurable —
    // this estate has already paid for that once (8 of 10 breakers logged {}).
    const v = summariseZeroYield(payload({ suppressed: 4 }))
    expect(v.detail).toMatch(/4 suppressed/)
  })

  it("caps how many it names but says how many it did not", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ pipeline: `lane-${i}`, runs_recent: 100 }))
    const v = summariseZeroYield(payload({ offenders: many }))
    expect(v.detail).toMatch(/11 lane\(s\)/)
    expect(v.detail).toMatch(/\+5 more/)
  })
})
