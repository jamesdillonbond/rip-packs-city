import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"
import {
  TIER_TOKEN,
  TIER_ORDER,
  tierToken,
  thumbnailFor,
  initialsFor,
  applyOptimisticUses,
  groupUsesByTier,
  applyUseBumps,
  runBadgeStatus,
  todayUtcDate,
  type Tier,
  type UseRowLike,
} from "@/lib/fast-break-client-compute"

// Pins the pure lineup/eligibility/tier logic lifted out of
// components/fast-break/FastBreakClient.tsx (which is invisible to the coverage
// ratchet). A regression here mis-groups the Run Progress widget, mis-applies
// optimistic use counts, or breaks the moment thumbnail / avatar fallbacks.

describe("tierToken", () => {
  it("returns the matching token for each known tier", () => {
    ;(Object.keys(TIER_TOKEN) as Tier[]).forEach(t => {
      expect(tierToken(t)).toBe(TIER_TOKEN[t])
    })
  })
  it("falls back to COMMON for an unexpected tier", () => {
    expect(tierToken("MYTHIC" as Tier)).toBe(TIER_TOKEN.COMMON)
  })
})

describe("thumbnailFor", () => {
  it("returns null for null/undefined/empty", () => {
    expect(thumbnailFor(null)).toBeNull()
    expect(thumbnailFor(undefined)).toBeNull()
    expect(thumbnailFor("")).toBeNull()
  })
  it("builds the assets CDN url for a moment id", () => {
    expect(thumbnailFor("abc123")).toBe(
      "https://assets.nbatopshot.com/media/abc123/image?width=180",
    )
  })
})

describe("initialsFor", () => {
  it("returns ?? for null/undefined/blank", () => {
    expect(initialsFor(null)).toBe("??")
    expect(initialsFor(undefined)).toBe("??")
    expect(initialsFor("   ")).toBe("??")
  })
  it("uses first two chars for a single-word name", () => {
    expect(initialsFor("Giannis")).toBe("GI")
    expect(initialsFor("Ai")).toBe("AI")
  })
  it("uses first+last initial for multi-word names, collapsing whitespace", () => {
    expect(initialsFor("Damian Lillard")).toBe("DL")
    expect(initialsFor("Shai  Gilgeous-Alexander")).toBe("SG")
    expect(initialsFor("  Luka   Doncic  ")).toBe("LD")
  })
})

describe("applyOptimisticUses", () => {
  const base: (UseRowLike & { fullName: string })[] = [
    { nbaPlayerId: "1", fullName: "A", highestTierOwned: "RARE", totalAllowed: 3, timesUsed: 1, remainingUses: 2 },
    { nbaPlayerId: "2", fullName: "B", highestTierOwned: "COMMON", totalAllowed: 2, timesUsed: 0, remainingUses: 2 },
  ]

  it("returns the base array unchanged when there are no pending bumps", () => {
    const out = applyOptimisticUses(base, {})
    expect(out).toBe(base)
  })

  it("bumps timesUsed and recomputes remainingUses", () => {
    const out = applyOptimisticUses(base, { "1": 1 })
    expect(out).not.toBe(base)
    expect(out[0]).toMatchObject({ timesUsed: 2, remainingUses: 1, fullName: "A" })
    // untouched row still bumps through the map (bump 0)
    expect(out[1]).toMatchObject({ timesUsed: 0, remainingUses: 2 })
  })

  it("clamps timesUsed to [0, totalAllowed]", () => {
    const over = applyOptimisticUses(base, { "1": 10 })
    expect(over[0]).toMatchObject({ timesUsed: 3, remainingUses: 0 })
    const under = applyOptimisticUses(base, { "2": -5 })
    expect(under[1]).toMatchObject({ timesUsed: 0, remainingUses: 2 })
  })
})

describe("groupUsesByTier", () => {
  type Row = { nbaPlayerId: string; highestTierOwned: Tier }
  const rows: Row[] = [
    { nbaPlayerId: "1", highestTierOwned: "COMMON" },
    { nbaPlayerId: "2", highestTierOwned: "ULTIMATE" },
    { nbaPlayerId: "3", highestTierOwned: "COMMON" },
    { nbaPlayerId: "4", highestTierOwned: "RARE" },
  ]

  it("groups by tier in TIER_ORDER and drops empty tiers", () => {
    const grouped = groupUsesByTier(rows)
    expect(grouped.map(g => g.tier)).toEqual(["ULTIMATE", "RARE", "COMMON"])
    expect(grouped.find(g => g.tier === "COMMON")?.rows.map(r => r.nbaPlayerId)).toEqual(["1", "3"])
    // FANDOM and LEGENDARY are absent -> dropped
    expect(grouped.some(g => g.tier === "FANDOM")).toBe(false)
    expect(grouped.some(g => g.tier === "LEGENDARY")).toBe(false)
  })

  it("returns an empty array for no rows", () => {
    expect(groupUsesByTier([])).toEqual([])
  })

  it("orders groups per TIER_ORDER (rarest first)", () => {
    expect(TIER_ORDER).toEqual(["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"])
  })
})

describe("applyUseBumps", () => {
  it("adds +1 per added and -1 per removed, floored at 0, from an empty base", () => {
    expect(applyUseBumps({}, ["x", "x", "y"], ["z"])).toEqual({ x: 2, y: 1, z: 0 })
  })
  it("merges onto existing counts without mutating the input", () => {
    const current = { a: 1, b: 2 }
    const out = applyUseBumps(current, ["a"], ["b"])
    expect(out).toEqual({ a: 2, b: 1 })
    expect(current).toEqual({ a: 1, b: 2 })
  })
  it("floors removed-below-zero at 0", () => {
    expect(applyUseBumps({ a: 0 }, [], ["a", "a"])).toEqual({ a: 0 })
  })
})

// ── run badge: a finished run must not render as LIVE ──────────────────────
//
// 🚨 Pins the 2026-09-19 defect. Production returned, from
// GET /api/nba/fast-break/optimize with no arguments:
//
//   run_name "Playoffs Run 1", run_is_active TRUE, run_end_date "2026-05-19"
//
// and the hero badge derived "live" from the BOOLEAN ALONE — pulsing red dot,
// red border, label "Ends May 19" — to a visitor in September. The flag is
// wrong in the data and correcting it is a product call; the surface must be
// honest regardless, because it is already holding the end date.
describe("runBadgeStatus", () => {
  const PROD_2026_09_19 = { run_is_active: true, run_end_date: "2026-05-19" }

  it("a run whose end date has PASSED is not live, whatever the flag says", () => {
    const got = runBadgeStatus(PROD_2026_09_19, "2026-09-19")
    expect(got.live).toBe(false)
    expect(got.label).toBe("Ended")
  })

  it("the same payload read BEFORE the end date is live — the no-change control", () => {
    // Without this the fix could be "never live", which would be a different lie.
    const got = runBadgeStatus(PROD_2026_09_19, "2026-05-01")
    expect(got.live).toBe(true)
    expect(got.label).toBe("Ends")
  })

  it("is live on the final day, not a day early (boundary)", () => {
    expect(runBadgeStatus(PROD_2026_09_19, "2026-05-19")).toEqual({ live: true, label: "Ends" })
    expect(runBadgeStatus(PROD_2026_09_19, "2026-05-20")).toEqual({ live: false, label: "Ended" })
  })

  it("an inactive future run reads 'From' and is not live", () => {
    expect(runBadgeStatus({ run_is_active: false, run_end_date: "2027-01-01" }, "2026-09-19"))
      .toEqual({ live: false, label: "From" })
  })

  it("an inactive PAST run reads 'Ended'", () => {
    expect(runBadgeStatus({ run_is_active: false, run_end_date: "2026-05-19" }, "2026-09-19"))
      .toEqual({ live: false, label: "Ended" })
  })

  it("with no end date it trusts the flag rather than inventing a date", () => {
    expect(runBadgeStatus({ run_is_active: true }, "2026-09-19")).toEqual({ live: true, label: "Ends" })
    expect(runBadgeStatus({ run_is_active: false }, "2026-09-19")).toEqual({ live: false, label: "From" })
  })

  it("tolerates null/undefined meta", () => {
    expect(runBadgeStatus(null, "2026-09-19")).toEqual({ live: false, label: "From" })
    expect(runBadgeStatus(undefined, "2026-09-19")).toEqual({ live: false, label: "From" })
  })
})

describe("todayUtcDate", () => {
  it("emits the YYYY-MM-DD shape run_end_date uses", () => {
    expect(todayUtcDate(new Date("2026-09-19T23:59:59Z"))).toBe("2026-09-19")
    expect(todayUtcDate(new Date("2026-09-20T00:00:00Z"))).toBe("2026-09-20")
  })
  it("compares correctly as a plain string against a run_end_date", () => {
    // The whole comparison is string-lexicographic on a fixed-width shape.
    expect("2026-05-19" < todayUtcDate(new Date("2026-09-19T12:00:00Z"))).toBe(true)
  })
})

// ⚠ THE HELPER TESTS ABOVE CANNOT SEE WHETHER THE CLIENT USES IT. A correct
// runBadgeStatus() next to a badge still reading `meta.run_is_active` is the
// exact shape this repo records as "a fix to the route is not a fix to the
// surface until its CALLER reaches it". So this asserts the wiring, on source,
// with comments stripped (the file's own comments quote the old expression).
describe("FastBreakClient is WIRED to runBadgeStatus", () => {
  const src = stripComments(
    readFileSync(join(process.cwd(), "app/nba/fast-break/FastBreakClient.tsx"), "utf8"),
  )

  it("imports and calls the helper", () => {
    expect(src).toMatch(/runBadgeStatus\s*\(/)
    expect(src).toMatch(/from\s+["']@\/lib\/fast-break-client-compute["']/)
  })

  it("derives the LIVE treatment from runBadge, not from the raw flag", () => {
    // The three badge decisions: background, border, dot, colour.
    expect(src).toMatch(/runBadge\.live\s*\?/)
    expect(src).toMatch(/\{runBadge\.live\s*&&/)
    expect(src).toMatch(/\{runBadge\.label\}/)
  })

  it("NO badge branch reads meta.run_is_active directly any more", () => {
    // The mutation this pins: reverting any of the four call sites.
    const offenders = [...src.matchAll(/meta\.run_is_active/g)]
    expect(
      offenders.length,
      `FastBreakClient still branches on meta.run_is_active ${offenders.length}x — ` +
        `a finished run will render as LIVE again. Use runBadgeStatus().`,
    ).toBe(0)
  })
})
