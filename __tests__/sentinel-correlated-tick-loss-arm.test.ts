import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  summariseCorrelatedTickLoss,
  CORRELATED_TICK_LOSS_DEFAULT_WARN_AT,
} from "@/lib/sentinel/correlated-tick-loss"

/**
 * R77 (filed 2026-09-03, calibrated 2026-10-03). Quiet hours: max 5 and max 3
 * in two independent 3-day windows. Real events: 16 / 28 (09-01), 116 (09-18).
 */
const pt = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) + " PT" : "unknown time"

const payload = (hours: Array<{ due_hour: string; pipelines: number; ticks?: number; sample?: string[] }>, clock = 132) => ({
  clock_pipelines: clock,
  recent: "03:00:00",
  hours,
})

describe("summariseCorrelatedTickLoss", () => {
  it("⭐ the 09-01 band (28 pipelines in one hour) warns and names the hour in PT", () => {
    const v = summariseCorrelatedTickLoss(
      payload([{ due_hour: "2026-09-01T04:00:00Z", pipelines: 28, ticks: 28, sample: ["a", "b"] }]),
      CORRELATED_TICK_LOSS_DEFAULT_WARN_AT,
      pt,
    )
    expect(v.status).toBe("warn")
    expect(v.value).toBe(28)
    expect(v.detail).toContain("28 of 132")
    expect(v.detail).toContain("9:00 PM PT")
    expect(v.detail).not.toMatch(/UTC|\dZ\b/)
  })

  it("the smallest real event (16) is above the threshold", () => {
    expect(16).toBeGreaterThanOrEqual(CORRELATED_TICK_LOSS_DEFAULT_WARN_AT)
  })

  it("the worst QUIET hour of either calibration window (5) does not warn", () => {
    const v = summariseCorrelatedTickLoss(
      payload([{ due_hour: "2026-10-03T18:00:00Z", pipelines: 5 }]),
      CORRELATED_TICK_LOSS_DEFAULT_WARN_AT,
      pt,
    )
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("5 of 132")
  })

  it("judges the WORST hour, whatever order the rows arrive in", () => {
    const v = summariseCorrelatedTickLoss(
      payload([
        { due_hour: "2026-10-03T18:00:00Z", pipelines: 1 },
        { due_hour: "2026-10-03T17:00:00Z", pipelines: 12 },
      ]),
      10,
      pt,
    )
    expect(v.status).toBe("warn")
    expect(v.value).toBe(12)
  })

  it("fires AT the threshold, not only above it", () => {
    expect(summariseCorrelatedTickLoss(payload([{ due_hour: "2026-10-03T18:00:00Z", pipelines: 10 }]), 10, pt).status).toBe("warn")
    expect(summariseCorrelatedTickLoss(payload([{ due_hour: "2026-10-03T18:00:00Z", pipelines: 9 }]), 10, pt).status).toBe("ok")
  })

  it("no misses at all is ok and says 0", () => {
    const v = summariseCorrelatedTickLoss(payload([]), 10, pt)
    expect(v.status).toBe("ok")
    expect(v.value).toBe(0)
  })

  // Three states: an unreadable payload or an empty population is UNMEASURED.
  it.each([
    ["null", null],
    ["no hours array", { clock_pipelines: 132 }],
    ["no clock count", { hours: [] }],
  ])("an unreadable payload (%s) is UNMEASURED, never ok", (_label, p) => {
    const v = summariseCorrelatedTickLoss(p as any, 10, pt)
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("UNMEASURED")
  })

  it("an EMPTY clock population is UNMEASURED — a broken read, not a quiet fleet", () => {
    const v = summariseCorrelatedTickLoss(payload([], 0), 10, pt)
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("UNMEASURED")
  })
})

describe("the migration and the default agree", () => {
  it("the seeded warn_at equals the code's fallback", () => {
    const sql = readFileSync(
      "supabase/migrations/20261003191353_audit_20261003_check_correlated_tick_loss_the_fleet_dip_no_per_pipeline_arm_can_see.sql",
      "utf8",
    )
    expect(sql).toMatch(new RegExp(`'Correlated Tick Loss', ${CORRELATED_TICK_LOSS_DEFAULT_WARN_AT}, NULL`))
  })
})
