import { describe, it, expect, vi, beforeEach } from "vitest"

const state: { result: any; throws: boolean; eqs: Array<[string, unknown]> } = { result: { data: [], error: null }, throws: false, eqs: [] }
function chain(): any {
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: any, rej: any) => (state.throws ? Promise.reject(new Error("transport")) : Promise.resolve(state.result)).then(res, rej)
      if (prop === "eq") return (k: string, v: unknown) => { state.eqs.push([k, v]); return b }
      return () => b
    },
  })
  return b
}
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => chain() } }))
import { buildWeeklyPacksBlock, loadPackWeek, minusDays, packWeekFrom, weeklyHeadline } from "@/lib/emails/weekly-packs"

beforeEach(() => { state.result = { data: [], error: null }; state.throws = false; state.eqs = [] })

describe("loadPackWeek", () => {
  it("reads the member's own snapshots and returns the week", async () => {
    state.result = { data: [
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "120", pack_held_count: 4 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "100", pack_held_count: 4 },
    ], error: null }
    expect(await loadPackWeek("u1")).toEqual({ lowAskUsd: 120, held: 4, listed: null, priorUsd: 100 })
    expect(state.eqs).toEqual([["owner_key", "u1"]])
  })
  it("a failed or thrown read omits the block (null), never $0", async () => {
    state.result = { data: null, error: { message: "boom" } }
    expect(await loadPackWeek("u1")).toBeNull()
    state.throws = true
    expect(await loadPackWeek("u1")).toBeNull()
  })
})

// Weekly email "Sealed packs" block (2026-11-22). Pins: no value -> no block (never $0);
// the weekly change only when the snapshot exactly 7 days earlier has a pack value.

describe("packWeekFrom", () => {
  it("is null when no snapshot carries a pack value, or none are held", () => {
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: null, pack_held_count: null }])).toBeNull()
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: 0, pack_held_count: 0 }])).toBeNull()
  })
  it("takes the latest value and the one 7 days before it (same holdings)", () => {
    expect(packWeekFrom([
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "27966.94", pack_held_count: 2155 },
      { snapshot_date: "2026-11-23", pack_low_ask_usd: 1, pack_held_count: 1 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "27000", pack_held_count: 2155 },
    ])).toEqual({ lowAskUsd: 27966.94, held: 2155, listed: null, priorUsd: 27000 })
  })
  // Re-pinned 2026-11-22: buying 5 packs (2150 → 2155) is not a price move, so no weekly change.
  it("a week with different holdings (bought / opened packs, or a pack gained its ask) gets no change figure", () => {
    expect(packWeekFrom([
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "27966.94", pack_held_count: 2155 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "27000", pack_held_count: 2150 },
    ])?.priorUsd).toBeNull()
    expect(packWeekFrom([
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "120", pack_held_count: 4, pack_listed_count: 4 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "90", pack_held_count: 4, pack_listed_count: 3 },
    ])?.priorUsd).toBeNull()
    expect(packWeekFrom([
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "120", pack_held_count: 4, pack_listed_count: 4 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "100", pack_held_count: 4, pack_listed_count: 4 },
    ])?.priorUsd).toBe(100)
  })
  it("no prior row 7 days back -> no change figure", () => {
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: 25533.7, pack_held_count: 327 }]))
      .toEqual({ lowAskUsd: 25533.7, held: 327, listed: null, priorUsd: null })
  })
  it("minusDays crosses a month in UTC", () => {
    expect(minusDays("2026-12-03", 7)).toBe("2026-11-26")
  })
})

describe("buildWeeklyPacksBlock", () => {
  it("omits the block with no value", () => {
    expect(buildWeeklyPacksBlock(null)).toEqual({ html: "", text: [] })
  })
  // RE-PINNED 2026-11-22 evening (Trevor: one number, "Yes proceed" to the email): the packs are IN the
  // Estimated value now, so this block is a breakdown line — no second weekly change of its own.
  it("prints the value and pack count as a breakdown of the value above, with no change of its own", () => {
    const b = buildWeeklyPacksBlock({ lowAskUsd: 27966.94, held: 2155, listed: null, priorUsd: 27000 })
    expect(b.html).toContain("$27,966.94")
    expect(b.html).toContain("2,155 sealed packs")
    expect(b.html).toContain("included above")
    expect(b.html).not.toContain("not in the value above")
    expect(b.text.join(" ")).not.toContain("this week")
    const first = buildWeeklyPacksBlock({ lowAskUsd: 2.39, held: 1, listed: null, priorUsd: null })
    expect(first.text.join(" ")).toContain("1 sealed pack at the lowest live ask")
  })
})

describe("weeklyHeadline — the email's one Estimated value", () => {
  const m = { latest_fmv: 49516.42, prior_fmv: 55830.66, delta_usd: -6314.24, delta_pct: -11.31 }
  it("no packs: the moments figures unchanged", () => {
    expect(weeklyHeadline(m, null)).toEqual({ valueUsd: 49516.42, deltaUsd: -6314.24, deltaPct: -11.31, scope: "all" })
  })
  it("packs with a like-for-like prior: total value AND total change", () => {
    const h = weeklyHeadline(m, { lowAskUsd: 16396.57, held: 488, listed: null, priorUsd: 16000 })
    expect(h.valueUsd).toBe(65912.99)
    expect(h.deltaUsd).toBe(-5917.67)
    expect(h.deltaPct).toBe(-8.24) // -5917.67 / (55830.66 + 16000)
    expect(h.scope).toBe("all")
  })
  it("packs without a comparable prior: total value, the change is the MOMENTS' and says so", () => {
    const h = weeklyHeadline(m, { lowAskUsd: 16396.57, held: 488, listed: null, priorUsd: null })
    expect(h.valueUsd).toBe(65912.99)
    expect(h.deltaUsd).toBe(-6314.24)
    expect(h.scope).toBe("moments")
  })
})

// 2026-11-22 (before the first send): the body now keeps the header's promise. On 11-22, 5 members'
// snapshots read held 1 / listed 0 / pack_low_ask_usd 0.00 — the email would have said "$0.00 — 1
// sealed pack at the lowest live ask".
describe("packWeekFrom — never a $0 or a stale sealed-pack line", () => {
  it("a 0 value with packs held is unpriced: no block", () => {
    expect(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: "0.00", pack_held_count: 1, pack_listed_count: 0 }])).toBeNull()
    expect(buildWeeklyPacksBlock(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: 0, pack_held_count: 3, pack_listed_count: 0 }])).text.join(" ")).not.toContain("$0.00")
  })
  it("an unfilled newest night omits the block instead of printing an older night as this week's", () => {
    expect(packWeekFrom([
      { snapshot_date: "2026-11-30", pack_low_ask_usd: null, pack_held_count: null },
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "120", pack_held_count: 4, pack_listed_count: 4 },
    ])).toBeNull()
  })
  it("says how many held packs the value covers when some have no live ask", () => {
    const w = packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: "5.64", pack_held_count: 4, pack_listed_count: 3 }])
    expect(w).toEqual({ lowAskUsd: 5.64, held: 4, listed: 3, priorUsd: null })
    const b = buildWeeklyPacksBlock(w)
    expect(b.html).toContain("3 of 4 sealed packs")
    expect(b.text.join(" ")).toContain("3 of 4 sealed packs at the lowest live ask")
  })
  it("all held packs listed reads as before", () => {
    const b = buildWeeklyPacksBlock(packWeekFrom([{ snapshot_date: "2026-11-22", pack_low_ask_usd: "19.36", pack_held_count: 11, pack_listed_count: 11 }]))
    expect(b.html).toContain("11 sealed packs at the lowest live ask")
    expect(b.html).not.toContain(" of 11")
  })
  it("a 0 prior is unpriced: no weekly change against it", () => {
    const w = packWeekFrom([
      { snapshot_date: "2026-11-29", pack_low_ask_usd: "12", pack_held_count: 1, pack_listed_count: 1 },
      { snapshot_date: "2026-11-22", pack_low_ask_usd: "0.00", pack_held_count: 1, pack_listed_count: 0 },
    ])
    expect(w?.priorUsd).toBeNull()
    expect(buildWeeklyPacksBlock(w).text.join(" ")).not.toContain("this week")
  })
})

describe("packWeekFrom — never a change against a backfilled estimate (20261122231506)", () => {
  it("a prior night whose pack value was backfilled gives no weekly change", () => {
    const rows = [
      { snapshot_date: "2026-11-23", pack_low_ask_usd: "120", pack_held_count: 4, pack_listed_count: 4 },
      { snapshot_date: "2026-11-16", pack_low_ask_usd: "100", pack_held_count: 4, pack_listed_count: 4, pack_value_basis: "carried_back_ask" },
    ]
    expect(packWeekFrom(rows)?.priorUsd).toBeNull()
    expect(packWeekFrom(rows)?.lowAskUsd).toBe(120)
  })
  it("both nights measured still compare", () => {
    expect(packWeekFrom([
      { snapshot_date: "2026-11-23", pack_low_ask_usd: "120", pack_held_count: 4, pack_listed_count: 4, pack_value_basis: null },
      { snapshot_date: "2026-11-16", pack_low_ask_usd: "100", pack_held_count: 4, pack_listed_count: 4, pack_value_basis: null },
    ])?.priorUsd).toBe(100)
  })
})
