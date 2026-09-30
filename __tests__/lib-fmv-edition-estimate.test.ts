import { describe, it, expect, vi, beforeEach } from "vitest"

// The thin-parallel value ESTIMATE (2026-09-30). It is a separate, labelled
// number — never the FMV. These pin: a half-formed or stale row is DROPPED, not
// rendered; a range that does not bracket the estimate is dropped; the basis is
// always stated; a failed read is `ok:false` with no estimate (never a guess).

let reply: { data: unknown; error: { message: string } | null } = { data: null, error: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(reply) }
      return b
    },
  },
}))

import {
  ESTIMATE_MAX_AGE_HOURS,
  estimateBasisText,
  estimateForModel,
  fetchEditionFmvEstimate,
  parseEstimateRow,
} from "@/lib/fmv/edition-estimate"

const NOW = Date.parse("2026-09-30T14:00:00Z")
const row = (o: Record<string, unknown> = {}) => ({
  edition_id: "874b3406-8156-4fc6-8099-e4fb881b5121",
  estimate_usd: "34.84",
  range_low_usd: "27.18",
  range_high_usd: "49.82",
  basis: "parallel_ratio",
  base_edition_id: "11777f73-f593-46d6-95cd-7f95e559507a",
  base_fmv_usd: "8.71",
  ratio: "4.0",
  subedition_name: "Jukebox",
  tier: "RARE",
  cell_n: 491,
  capped_at_ask: false,
  computed_at: "2026-09-30T12:00:00Z",
  ...o,
})
const usd = (n: number) => "$" + n.toFixed(2)

beforeEach(() => { reply = { data: null, error: null } })

describe("parseEstimateRow", () => {
  it("coerces a complete row (numerics as strings)", () => {
    const e = parseEstimateRow(row(), NOW)!
    expect(e.estimate_usd).toBe(34.84)
    expect(e.range_low_usd).toBe(27.18)
    expect(e.range_high_usd).toBe(49.82)
    expect(e.ratio).toBe(4)
    expect(e.subedition_name).toBe("Jukebox")
  })

  it.each([
    ["no estimate", { estimate_usd: null }],
    ["zero estimate", { estimate_usd: 0 }],
    ["no base FMV", { base_fmv_usd: null }],
    ["no ratio", { ratio: null }],
    ["no cell size", { cell_n: 0 }],
    ["unknown basis", { basis: "last_sale" }],
    ["no parallel name", { subedition_name: " " }],
    ["no timestamp", { computed_at: null }],
  ])("drops a half-formed row: %s", (_label, o) => {
    expect(parseEstimateRow(row(o), NOW)).toBeNull()
  })

  it("drops an estimate older than the max age — the base FMV it multiplies has moved on", () => {
    const old = new Date(NOW - (ESTIMATE_MAX_AGE_HOURS + 1) * 3_600_000).toISOString()
    expect(parseEstimateRow(row({ computed_at: old }), NOW)).toBeNull()
    const fresh = new Date(NOW - (ESTIMATE_MAX_AGE_HOURS - 1) * 3_600_000).toISOString()
    expect(parseEstimateRow(row({ computed_at: fresh }), NOW)).not.toBeNull()
  })

  it("a range that does not bracket the estimate is dropped, the estimate kept", () => {
    const e = parseEstimateRow(row({ range_low_usd: 40, range_high_usd: 50 }), NOW)!
    expect(e.estimate_usd).toBe(34.84)
    expect(e.range_low_usd).toBeNull()
    expect(e.range_high_usd).toBeNull()
  })

  it("null / non-object input is no estimate", () => {
    expect(parseEstimateRow(null, NOW)).toBeNull()
    expect(parseEstimateRow("x", NOW)).toBeNull()
  })
})

describe("the basis is always stated", () => {
  it("names the full-edition FMV, the parallel type, the premium and its sample", () => {
    const t = estimateBasisText(parseEstimateRow(row(), NOW)!, usd)
    expect(t).toContain("full-edition FMV $8.71")
    expect(t).toContain("Jukebox premium (4.0×")
    expect(t).toContain("491 editions")
    expect(t).not.toMatch(/capped/)
    expect(estimateBasisText(parseEstimateRow(row({ capped_at_ask: true }), NOW)!, usd)).toContain("capped at the lowest ask")
  })

  it("the concierge shape says it is NOT the FMV", () => {
    const m = estimateForModel(parseEstimateRow(row(), NOW)!)
    expect(m.estimate_usd).toBe(34.84)
    expect(m.likely_range_usd).toEqual([27.18, 49.82])
    expect(String(m.how_to_use)).toMatch(/not the FMV/)
    expect(m).not.toHaveProperty("fmv_usd")
  })
})

describe("fetchEditionFmvEstimate", () => {
  it("a failed read is ok:false with NO estimate", async () => {
    reply = { data: null, error: { message: "boom" } }
    expect(await fetchEditionFmvEstimate("e1")).toEqual({ estimate: null, ok: false })
  })
  it("no row is ok:true with no estimate", async () => {
    expect(await fetchEditionFmvEstimate("e1")).toEqual({ estimate: null, ok: true })
  })
  it("no edition id asks nothing", async () => {
    expect(await fetchEditionFmvEstimate(null)).toEqual({ estimate: null, ok: true })
  })
  it("a fresh row comes back parsed", async () => {
    reply = { data: row({ computed_at: new Date().toISOString() }), error: null }
    const r = await fetchEditionFmvEstimate("e1")
    expect(r.ok).toBe(true)
    expect(r.estimate?.estimate_usd).toBe(34.84)
  })
})
