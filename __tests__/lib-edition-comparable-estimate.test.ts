import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import {
  parseComparableRow,
  comparableBasisText,
  comparableForModel,
  COMPARABLE_MIN_SET_MATES,
  COMPARABLE_ESTIMATE_COLLECTIONS,
  ESTIMATE_MAX_AGE_HOURS,
  ESTIMATE_MIN_USD,
} from "@/lib/fmv/edition-estimate"

// The comparable-edition estimate (2026-11-12) is shown for an edition with NO price. It is a
// guide, never an FMV, and only the SET basis was measured usable — so the parser is the gate:
// a bucket/tier fallback row, a thin set, a stale row or a sub-$1 guess must render NOTHING.

const NOW = Date.parse("2026-11-12T18:00:00Z")
const fresh = "2026-11-12T13:36:00Z"
const row = (over: Record<string, unknown> = {}) => ({
  edition_id: "11111111-1111-1111-1111-111111111111",
  est_usd: "12.34",
  baseline_kind: "set",
  n_set: 14,
  n_player: 6,
  computed_at: fresh,
  ...over,
})

describe("parseComparableRow", () => {
  it("accepts a fresh set-basis row and coerces string numerics", () => {
    expect(parseComparableRow(row(), NOW)).toEqual({
      edition_id: "11111111-1111-1111-1111-111111111111",
      estimate_usd: 12.34,
      n_set: 14,
      n_player: 6,
      computed_at: fresh,
      parallel_blend: false,
    })
  })

  // 2026-11-13: a Top Shot parallel's comp-1.1 number is a blend with its base edition — flagged so the basis can say so.
  it("flags a parallel blend from parallel_est_usd, and only then", () => {
    expect(parseComparableRow(row({ parallel_est_usd: "9.10" }), NOW)?.parallel_blend).toBe(true)
    expect(parseComparableRow(row({ parallel_est_usd: null }), NOW)?.parallel_blend).toBe(false)
    expect(parseComparableRow(row({ parallel_est_usd: 0 }), NOW)?.parallel_blend).toBe(false)
  })

  it("drops the weaker fallbacks — only the set basis is shown", () => {
    expect(parseComparableRow(row({ baseline_kind: "bucket" }), NOW)).toBeNull()
    expect(parseComparableRow(row({ baseline_kind: "tier" }), NOW)).toBeNull()
    expect(parseComparableRow(row({ baseline_kind: null }), NOW)).toBeNull()
  })

  it("drops a set with too few priced set-mates", () => {
    expect(parseComparableRow(row({ n_set: COMPARABLE_MIN_SET_MATES - 1 }), NOW)).toBeNull()
    expect(parseComparableRow(row({ n_set: COMPARABLE_MIN_SET_MATES }), NOW)).not.toBeNull()
  })

  it("drops a missing, non-positive or sub-floor estimate", () => {
    expect(parseComparableRow(row({ est_usd: null }), NOW)).toBeNull()
    expect(parseComparableRow(row({ est_usd: 0 }), NOW)).toBeNull()
    expect(parseComparableRow(row({ est_usd: ESTIMATE_MIN_USD - 0.01 }), NOW)).toBeNull()
  })

  it("drops a stale row and a row with no stamp", () => {
    const old = new Date(NOW - (ESTIMATE_MAX_AGE_HOURS + 1) * 3_600_000).toISOString()
    expect(parseComparableRow(row({ computed_at: old }), NOW)).toBeNull()
    expect(parseComparableRow(row({ computed_at: null }), NOW)).toBeNull()
  })

  it("drops a non-object and a row with no edition id", () => {
    expect(parseComparableRow(null, NOW)).toBeNull()
    expect(parseComparableRow(row({ edition_id: 7 }), NOW)).toBeNull()
  })

  it("reads an absent player count as zero, not as a failure", () => {
    expect(parseComparableRow(row({ n_player: null }), NOW)?.n_player).toBe(0)
  })
})

describe("comparableBasisText", () => {
  it("states the set-mates and the player adjustment when there is one", () => {
    const e = parseComparableRow(row(), NOW)!
    const t = comparableBasisText(e)
    expect(t).toContain("14 other editions in this set that have sold")
    expect(t).toContain("this player's other editions")
  })

  it("does not claim a player adjustment that was not made", () => {
    const e = parseComparableRow(row({ n_player: 0 }), NOW)!
    expect(comparableBasisText(e)).not.toContain("player")
  })

  it("names the base-edition half of a parallel blend instead of claiming set-mates only", () => {
    const blended = comparableBasisText(parseComparableRow(row({ parallel_est_usd: "9.10" }), NOW)!)
    expect(blended).toContain("14 other editions in this set that have sold")
    expect(blended).toMatch(/base edition price/)
    // control: a non-parallel row never mentions a base edition
    expect(comparableBasisText(parseComparableRow(row(), NOW)!)).not.toMatch(/base edition/)
  })

  it("never uses the confidence vocabulary", () => {
    const t = comparableBasisText(parseComparableRow(row(), NOW)!)
    expect(t).not.toMatch(/\b(HIGH|MEDIUM|LOW|STALE|confidence)\b/i)
  })
})

describe("COMPARABLE_ESTIMATE_COLLECTIONS", () => {
  it("is the three collections the estimate was measured usable on — never Candy", () => {
    expect([...COMPARABLE_ESTIMATE_COLLECTIONS].sort()).toEqual(["laliga-golazos", "nba-top-shot", "nfl-all-day"])
    expect(COMPARABLE_ESTIMATE_COLLECTIONS.has("candy-mlb")).toBe(false)
  })
})

describe("comparableForModel (the concierge's view)", () => {
  const e = parseComparableRow(row(), NOW)!
  const m = comparableForModel(e)

  it("carries the number, what it rests on, and its own instruction", () => {
    expect(m.estimate_usd).toBe(12.34)
    expect(m.set_mates_priced_from_sales).toBe(14)
    expect(m.player_adjustment_from_other_editions).toBe(6)
    expect(String(m.how_to_use)).toMatch(/NO FMV/)
    expect(String(m.how_to_use)).toMatch(/Never call it the FMV/)
  })

  it("does not claim a player adjustment that was not made", () => {
    expect(comparableForModel(parseComparableRow(row({ n_player: 0 }), NOW)!).player_adjustment_from_other_editions).toBeNull()
  })

  it("tells the model when the number is a parallel blend", () => {
    const b = comparableForModel(parseComparableRow(row({ parallel_est_usd: "9.10" }), NOW)!)
    expect(b.blended_with_base_edition_and_parallel_premium).toBe(true)
    expect(String(b.basis)).toMatch(/base_edition/)
    expect(m.blended_with_base_edition_and_parallel_premium).toBe(false)
    expect(String(m.basis)).not.toMatch(/base_edition/)
  })

  it("never hands the model a confidence tier", () => {
    expect(JSON.stringify(m)).not.toMatch(/\b(HIGH|MEDIUM|LOW|STALE|ASK_ONLY|confidence)\b/)
  })
})
