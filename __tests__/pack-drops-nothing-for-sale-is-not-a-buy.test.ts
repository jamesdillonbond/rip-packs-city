// 2026-10-20 live sweep: /insights/pack-drops read "Sale open 6 · RPC ≥ ask 6" and
// "RPC values this pack at ~$X vs ~$Y to buy — RPC FMV exceeds the ask" on six drops
// whose sale state was listed: 0 (four sold out, two operator test drops with 0 total).
import { describe, it, expect } from "vitest"
import { applySaleState, isBuyableNow, type ScoredDrop } from "@/lib/pack-drops-board"

const drop = (): ScoredDrop =>
  ({
    rpc_pack_ev_usd: 12.5,
    verdict: "RPC values this pack at ~$12.50 vs ~$9.00 to buy — RPC FMV exceeds the ask.",
    verdict_kind: "value",
    sale_state: null,
  }) as unknown as ScoredDrop

describe("pack drops: a drop with nothing for sale makes no buy claim", () => {
  it("sold out → no 'to buy' price, not counted as value", () => {
    const s = applySaleState(drop(), { listed: 0, sold: 500, total: 500, saleOpen: true, soldOut: true })
    expect(s.verdict).not.toMatch(/to buy|exceeds the ask/)
    expect(s.verdict).toMatch(/None is for sale right now/)
    expect(s.verdict_kind).toBe("unknown")
    expect(isBuyableNow(s.sale_state)).toBe(false)
  })

  it("saleOpen with listed 0 is not buyable either", () => {
    expect(isBuyableNow({ listed: 0, sold: 0, total: 0, saleOpen: true, soldOut: false })).toBe(false)
  })

  it("a buyable drop keeps its verdict (control)", () => {
    const st = { listed: 40, sold: 10, total: 50, saleOpen: true, soldOut: false }
    const s = applySaleState(drop(), st)
    expect(isBuyableNow(st)).toBe(true)
    expect(s.verdict_kind).toBe("value")
    expect(s.verdict).toMatch(/exceeds the ask/)
  })

  it("an UNKNOWN sale state (failed read) leaves the verdict as scored", () => {
    const s = applySaleState(drop(), null)
    expect(s.verdict_kind).toBe("value")
    expect(isBuyableNow(null)).toBe(false)
  })
})
