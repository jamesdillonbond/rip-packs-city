import { describe, it, expect } from "vitest"

process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321"
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test"

import { summariseContinuity, CONTINUITY_GAP_WARN_MIN, CONTINUITY_CHECK_NAME } from "@/lib/sentinel/continuity"
import { readPreviousSweep, formatPT } from "@/app/api/sentinel/route"
import { readFileSync } from "node:fs"

/**
 * R77, 2026-10-03: on 09-18 the sentinel was blind from 12:04:07Z to 19:04:07Z
 * (5:04 AM → 12:04 PM PT) and its first sweep back said nothing about that.
 * This arm dates the alarm's own blind window. Threshold measured: 86 completed
 * sweeps 09-30 → 10-03, max gap 60.02 min, zero over 90.
 */

describe("summariseContinuity", () => {
  it("⭐ the 09-18 outage: names the blind window, in PT, with its length", () => {
    const v = summariseContinuity({ ok: true, at: "2026-09-18T12:04:07Z" }, "2026-09-18T19:04:07Z", formatPT)
    expect(v.status).toBe("warn")
    expect(v.value).toBe(420)
    expect(v.detail).toContain("THIS ALARM WAS BLIND for 7h 0m")
    expect(v.detail).toContain("5:04 AM PT")
    expect(v.detail).toContain("12:04 PM PT")
    expect(v.detail).not.toMatch(/UTC|\dZ\b/)
  })

  it("a normal hourly gap is ok — the arm is quiet on the cadence it was measured on", () => {
    const v = summariseContinuity({ ok: true, at: "2026-10-03T18:04:07Z" }, "2026-10-03T19:04:08Z", formatPT)
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("1h 0m ago")
  })

  it("fires only PAST the threshold, not at it", () => {
    const prev = "2026-10-03T12:00:00Z"
    const at = (min: number) => new Date(Date.parse(prev) + min * 60_000).toISOString()
    expect(summariseContinuity({ ok: true, at: prev }, at(CONTINUITY_GAP_WARN_MIN), formatPT).status).toBe("ok")
    expect(summariseContinuity({ ok: true, at: prev }, at(CONTINUITY_GAP_WARN_MIN + 1), formatPT).status).toBe("warn")
  })

  it("the threshold sits above two missed hourly slots, so jitter cannot fire it", () => {
    expect(CONTINUITY_GAP_WARN_MIN).toBeGreaterThan(2 * 60)
  })

  // Three states: a failed read is UNMEASURED, never "continuous".
  it("an unreadable previous sweep is UNMEASURED, never ok", () => {
    const v = summariseContinuity({ ok: false, reason: "read did not answer within 8s" }, "2026-10-03T19:04:08Z", formatPT)
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("UNMEASURED")
    expect(v.detail).not.toMatch(/ago|BLIND for/)
  })

  it("a row read without usable names still yields a measured gap", () => {
    const v = summariseContinuity(
      { ok: false, reason: "earlier sweep stored no check names", at: "2026-09-18T12:04:07Z" },
      "2026-09-18T19:04:07Z",
      formatPT,
    )
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("BLIND for 7h 0m")
  })

  it("a row with no readable start time is UNMEASURED", () => {
    const v = summariseContinuity({ ok: true, at: "not-a-date" }, "2026-10-03T19:04:08Z", formatPT)
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("UNMEASURED")
  })
})

describe("the previous read skips rows the RUNNER wrote", () => {
  // pipeline-sentinel.yml writes a `sentinel` row with source=github-actions
  // when the route did NOT answer. Counting it as a sweep would hide the
  // blind window the arm exists to date.
  it("measures from the last sweep the ROUTE completed", async () => {
    const rows = [
      { started_at: "2026-09-18T16:48:45Z", extra: { source: "github-actions", observed: "route_unreachable" } },
      { started_at: "2026-09-18T12:04:07Z", extra: { warn: ["Dune Spend"], critical: [] } },
    ]
    const chain: any = {
      from: () => chain, select: () => chain, eq: () => chain, lt: () => chain, order: () => chain,
      limit: async () => ({ data: rows, error: null }),
    }
    const prev = await readPreviousSweep(chain, "2026-09-18T19:04:07Z")
    expect(prev).toEqual({ ok: true, names: ["Dune Spend"], at: "2026-09-18T12:04:07Z" })
    expect(summariseContinuity(prev, "2026-09-18T19:04:07Z", formatPT).detail).toContain("BLIND for 7h 0m")
  })
})

describe("wiring", () => {
  const src = readFileSync("app/api/sentinel/route.ts", "utf8")
  it("the route pushes the arm, ahead of the ack pass (so it is ackable)", () => {
    const pushAt = src.indexOf("name: CONTINUITY_CHECK_NAME")
    const ackAt = src.indexOf("const ack = cfgMap[c.name]?.ack;")
    expect(pushAt).toBeGreaterThan(0)
    expect(pushAt).toBeLessThan(ackAt)
    expect(CONTINUITY_CHECK_NAME).toBe("Alarm Continuity")
  })
})
