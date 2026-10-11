import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import { fetchCandyConfirmedFloors } from "@/lib/fmv-candy-ceiling"
import {
  escalateConfidence,
  MAX_ASK_AGE_HOURS_CORROBORATION,
  MIN_SALES_ASK_CORROBORATION,
} from "@/lib/fmv-confidence"

// ── Candy MLB editions can be ask-corroborated (2026-10-11) ───────────────────
//
// The confirmed Candy ask (candy_listing_floor.confirmed_floor_usd) has CAPPED Candy
// FMVs since 2026-09-25 — trusted to override the sales evidence downward — while
// ask-corroboration stayed Top-Shot / All-Day-only, so no Candy edition could be
// lifted LOW -> MEDIUM by an ask that AGREES with its sales. 75 of 91 Candy LOW
// editions had >= 10 sales in 30 d on the day this shipped. Measured out of sample:
// the editions it lifts priced at MdAPE 19.2 % over the next 7 d, against 20.0 % for
// Candy MEDIUM and 27.3 % for the LOW that stays LOW.
//
// Pinned as PROPERTIES: Candy reaches corroboration at all; the ask and its age travel
// together; an undatable or old Candy ask withholds; nothing here moves a price.

const ROUTE = path.join(path.resolve(__dirname, ".."), "app/api/fmv-recalc/route.ts")
const RAW = readFileSync(ROUTE, "utf8")
const SRC = stripComments(RAW)

function fakeSupabase(rows: unknown[]) {
  return {
    from() {
      const q = {
        select: () => q,
        in: () => q,
        gt: () => Promise.resolve({ data: rows, error: null }),
      }
      return q
    },
  }
}

describe("the comment stripper actually stripped", () => {
  it("removed prose and kept code", () => {
    expect(RAW).toContain("the All Day inconsistency of 2026-09-09 again")
    expect(SRC).not.toContain("the All Day inconsistency of 2026-09-09 again")
    expect(SRC).toContain("escalateConfidence(")
  })
})

describe("fetchCandyConfirmedFloors carries WHEN each ask was seen", () => {
  it("returns last_seen_at beside the floor, and null — never a fabricated time — when absent", async () => {
    const r = await fetchCandyConfirmedFloors(fakeSupabase([
      { edition_id: "a", confirmed_floor_usd: 4, last_seen_at: "2026-10-11T18:35:18Z" },
      { edition_id: "b", confirmed_floor_usd: 5, last_seen_at: null },
      { edition_id: "c", confirmed_floor_usd: 6 },
    ]), ["a", "b", "c"])
    expect([...r.floors]).toEqual([["a", 4], ["b", 5], ["c", 6]])
    expect(r.seenAt.get("a")).toBe("2026-10-11T18:35:18Z")
    expect(r.seenAt.get("b")).toBeNull()
    expect(r.seenAt.get("c")).toBeNull()
  })

  it("has no seenAt entry for an ask it dropped (a dropped ask cannot corroborate)", async () => {
    const r = await fetchCandyConfirmedFloors(fakeSupabase([
      { edition_id: "z", confirmed_floor_usd: 0, last_seen_at: "2026-10-11T00:00:00Z" },
    ]), ["z"])
    expect(r.floors.has("z")).toBe(false)
    expect(r.seenAt.has("z")).toBe(false)
  })
})

describe("fmv-recalc feeds the Candy ask into CORROBORATION, as a pair with its age", () => {
  it("🚨 Candy floors reach editionAskById (not only the ceiling)", () => {
    expect(
      SRC,
      "the Candy confirmed floor no longer feeds editionAskById — Candy cannot be corroborated again",
    ).toMatch(/candyCeiling\.floors\)[\s\S]{0,400}?editionAskById\.set\(/)
  })

  it("🚨 every Candy ask written to editionAskById has its age written beside it", () => {
    const block = SRC.match(/for \(const \[edId, ask\] of candyCeiling\.floors\)\s*\{[\s\S]*?\n {4}\}/)
    expect(block, "the Candy corroboration loop is gone").not.toBeNull()
    expect(block![0]).toContain("editionAskById.set(edId, ask)")
    expect(block![0]).toContain("editionAskAgeHoursById.set(edId,")
    // the age comes from when the listing was SEEN; an unparseable stamp is null
    expect(block![0]).toContain("candyCeiling.seenAt.get(edId)")
    expect(block![0]).toMatch(/Number\.isNaN\(seenMs\)\s*\?\s*null/)
  })

  it("never overwrites an ask another source already supplied", () => {
    const block = SRC.match(/for \(const \[edId, ask\] of candyCeiling\.floors\)\s*\{[\s\S]*?\n {4}\}/)
    expect(block![0]).toMatch(/if \(editionAskById\.has\(edId\)\) continue/)
  })

  it("is recorded in the run's extra, so a dead feed shows as 0, not as silence", () => {
    expect(SRC).toContain("candy_corroboration_asks: candyCorroborationAsks")
  })
})

describe("what a Candy ask can and cannot do to confidence", () => {
  const tight = Array(MIN_SALES_ASK_CORROBORATION).fill(3)

  it("lifts a thin LOW edition whose sales agree with a fresh ask", () => {
    expect(escalateConfidence("LOW", MIN_SALES_ASK_CORROBORATION, tight, undefined, 3.2, 1.3)).toBe("MEDIUM")
  })

  it("does not lift on an undatable ask (null age)", () => {
    expect(escalateConfidence("LOW", MIN_SALES_ASK_CORROBORATION, tight, undefined, 3.2, null)).toBe("LOW")
  })

  it("does not lift on an ask older than the corroboration bound", () => {
    expect(
      escalateConfidence("LOW", MIN_SALES_ASK_CORROBORATION, tight, undefined, 3.2, MAX_ASK_AGE_HOURS_CORROBORATION + 1),
    ).toBe("LOW")
  })

  it("does not lift when the ask disagrees with the sales (outside +/-25 %)", () => {
    expect(escalateConfidence("LOW", MIN_SALES_ASK_CORROBORATION, tight, undefined, 5, 1)).toBe("LOW")
  })
})
