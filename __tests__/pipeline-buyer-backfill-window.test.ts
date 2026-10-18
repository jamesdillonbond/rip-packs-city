import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { CURRENT_SPORK_START_ISO, buyerBackfillVerdict } from "@/lib/pipeline/buyer-backfill-window"

// #192: the All Day/Golazos buyer backfill walked rows older than mainnet27's
// root (2025-10-22), which current-spork REST cannot decode — 480 of 480 failed
// every run, 0 written, ok=true. These pin the floor and the verdict.
describe("buyer backfill window + verdict (#192)", () => {
  it("floors the window at mainnet27's root, not a calendar year", () => {
    expect(CURRENT_SPORK_START_ISO).toBe("2025-10-22T00:00:00Z")
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/const FORWARD_WINDOW_START = CURRENT_SPORK_START_ISO/)
    expect(route).not.toMatch(/"2025-01-01T00:00:00Z"/)
  })

  it("a batch where every row fails to decode is a FAILED run, not ok", () => {
    const v = buyerBackfillVerdict({ found: 480, decodeFailed: 480, updateFailed: 0 })
    expect(v.ok).toBe(false)
    expect(v.error).toMatch(/decode wall/)
  })

  it("a swallowed UPDATE error fails the run", () => {
    expect(buyerBackfillVerdict({ found: 10, decodeFailed: 0, updateFailed: 1 }).ok).toBe(false)
  })

  it("partial decode misses and an empty batch stay ok", () => {
    expect(buyerBackfillVerdict({ found: 480, decodeFailed: 12, updateFailed: 0 })).toEqual({ ok: true, error: null })
    expect(buyerBackfillVerdict({ found: 0, decodeFailed: 0, updateFailed: 0 }).ok).toBe(true)
  })

  it("the route counts update errors and applies the verdict", () => {
    const route = readFileSync("app/api/admin/backfill-allday-buyers/route.ts", "utf8")
    expect(route).toMatch(/updateFailed\+\+/)
    expect(route).toMatch(/buyerBackfillVerdict\(\{ found, decodeFailed, updateFailed \}\)/)
    expect(route).toMatch(/update_failed: updateFailed/)
  })
})
