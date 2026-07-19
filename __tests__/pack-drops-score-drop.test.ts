import { describe, it, expect } from "vitest"
import { scoreDrop } from "@/lib/pack-drops-board"
import type {
  VaultopolisComposition,
  VaultopolisAsset,
  VaultopolisDropListItem,
} from "@/lib/pack-drops-board"

// Unit tests for scoreDrop — the RPC Packs lot-pricing engine. It groups a drop's
// TopShot assets by (player, set, series), prices each group against RPC FMV via
// the get_pack_drop_pricing RPC (falling back to the operator's estimatedValue on
// a miss), sums the pool, derives per-pack EV, and renders a value/premium/fair
// verdict against the USD pack price. The route test fully stubs fetchScoredDrops,
// so this is the only place the pricing math is exercised. keyOf lowercases
// player+set, so the pricing map must be built the same way to match.

function keyOf(player: string | null, set: string | null, series: number | null) {
  return `${(player ?? "").toLowerCase()}|${(set ?? "").toLowerCase()}|${series ?? ""}`
}

function asset(o: Partial<VaultopolisAsset>): VaultopolisAsset {
  return {
    nftId: 1,
    valueTier: null,
    playerName: null,
    setName: null,
    serialNumber: null,
    momentCount: null,
    series: null,
    tier: null,
    estimatedValue: null,
    floorPrice: null,
    ...o,
  }
}

function comp(o: Partial<VaultopolisComposition>): VaultopolisComposition {
  return {
    dropId: 1,
    name: "Drop",
    displayName: "Drop",
    description: null,
    packCount: 10,
    nftsPerPack: 4,
    totalNfts: 40,
    openedCount: 0,
    status: "live",
    assets: { TopShot: [] },
    ...o,
  }
}

/** A Supabase stub whose get_pack_drop_pricing returns the given priced rows. */
function sbWithPricing(rows: any[], opts: { error?: string; capture?: (args: any) => void } = {}) {
  return {
    rpc: async (_name: string, args: any) => {
      opts.capture?.(args)
      if (opts.error) return { data: null, error: { message: opts.error } }
      return { data: rows, error: null }
    },
  } as any
}

// Three groups: LeBron×2 (RPC-matched @50), Curry×1 (unmatched → operator est 20),
// Durant×1 parallel (RPC-matched @10). Pool = 100 + 20 + 10 = 130.
const THREE_GROUP_ASSETS: VaultopolisAsset[] = [
  asset({ playerName: "LeBron", setName: "Set A", series: 4, estimatedValue: 999 }),
  asset({ playerName: "LeBron", setName: "Set A", series: 4, estimatedValue: 999 }),
  asset({ playerName: "Curry", setName: "Set B", series: 4, estimatedValue: 20 }),
  asset({ playerName: "Durant", setName: "Set C", series: 4, estimatedValue: 5, subeditionId: 5 }),
]
const PRICING = [
  { player: "LeBron", setname: "Set A", series: 4, edition_matches: 3, rpc_fmv_avg: "50", rpc_fmv_min: 40, rpc_fmv_max: 60, confidence: "HIGH" },
  { player: "Durant", setname: "Set C", series: 4, edition_matches: 1, rpc_fmv_avg: 10, rpc_fmv_min: 10, rpc_fmv_max: 10, confidence: "MEDIUM" },
]

describe("scoreDrop — grouping, pricing, pool & EV", () => {
  it("groups by (player,set,series), prices matched groups off RPC FMV and falls back to operator est", async () => {
    const sb = sbWithPricing(PRICING)
    const res = await scoreDrop(sb, comp({ assets: { TopShot: THREE_GROUP_ASSETS } }), null, 1)

    expect(res.total_distinct).toBe(3)
    expect(res.matched_count).toBe(2) // LeBron + Durant matched; Curry fell back
    expect(res.rpc_pool_usd).toBe(130) // 50*2 + 20*1 + 10*1
    expect(res.rpc_pack_ev_usd).toBe(13) // pool / packCount(10)

    const lebron = res.rows.find((r) => r.player === "LeBron")!
    expect(lebron.count).toBe(2)
    expect(lebron.rpc_fmv_avg).toBe(50) // string "50" coerced
    expect(lebron.matched).toBe(true)
    expect(lebron.confidence).toBe("HIGH")
    expect(lebron.pool_contribution).toBe(100)
    expect(lebron.used_fallback).toBe(false)

    const curry = res.rows.find((r) => r.player === "Curry")!
    expect(curry.matched).toBe(false)
    expect(curry.rpc_fmv_avg).toBeNull()
    expect(curry.used_fallback).toBe(true) // priced off estimatedValue 20
    expect(curry.pool_contribution).toBe(20)
  })

  it("flags parallels and sorts rows by pool contribution descending", async () => {
    const res = await scoreDrop(sbWithPricing(PRICING), comp({ assets: { TopShot: THREE_GROUP_ASSETS } }), null, 1)
    expect(res.has_parallel).toBe(true) // Durant carried subeditionId > 0
    expect(res.rows.find((r) => r.player === "Durant")!.is_parallel).toBe(true)
    expect(res.rows.map((r) => r.pool_contribution)).toEqual([100, 20, 10]) // sorted desc
  })

  it("computes value concentration as the top row's share of the pool", async () => {
    const res = await scoreDrop(sbWithPricing(PRICING), comp({ assets: { TopShot: THREE_GROUP_ASSETS } }), null, 1)
    expect(res.value_concentration_pct).toBe(76.9) // 100/130 → 76.9%
  })

  it("passes the jsonb key as `setname` (not `set`) to the pricing RPC", async () => {
    let captured: any = null
    const sb = sbWithPricing(PRICING, { capture: (a) => (captured = a) })
    await scoreDrop(sb, comp({ assets: { TopShot: THREE_GROUP_ASSETS } }), null, 1)
    expect(captured.p_eds[0]).toHaveProperty("setname")
    expect(captured.p_eds[0]).not.toHaveProperty("set")
  })

  it("survives an RPC error by pricing everything off the operator estimate", async () => {
    const assets = [asset({ playerName: "Curry", setName: "Set B", series: 4, estimatedValue: 20 })]
    const res = await scoreDrop(sbWithPricing([], { error: "boom" }), comp({ assets: { TopShot: assets } }), null, 1)
    expect(res.matched_count).toBe(0)
    expect(res.rpc_pool_usd).toBe(20) // fell back to estimatedValue
    expect(res.rows[0].used_fallback).toBe(true)
  })

  it("contributes 0 for an unmatched group with no operator estimate", async () => {
    const assets = [asset({ playerName: "Ghost", setName: "Set Z", series: 4, estimatedValue: null })]
    const res = await scoreDrop(sbWithPricing([]), comp({ assets: { TopShot: assets } }), null, 1)
    expect(res.rpc_pool_usd).toBe(0)
    expect(res.rows[0].used_fallback).toBe(false)
  })
})

describe("scoreDrop — pack price + verdict thresholds", () => {
  const listItem = (listingPrice: number | null): VaultopolisDropListItem => ({
    dropId: 1,
    displayName: "Drop",
    status: "live",
    packCount: 10,
    openedCount: 0,
    listedCount: null,
    purchasedCount: null,
    listingPrice,
    listingCurrency: "flow",
  })
  // pool 130, packCount 10 → packEv 13.
  const base = () => comp({ assets: { TopShot: THREE_GROUP_ASSETS } })

  it("ratio >= 1.15 → 'value' (RPC FMV exceeds the ask)", async () => {
    // listingPrice 100 FLOW / 10 packs = 10 FLOW * $1 = $10 ask; 13/10 = 1.3
    const res = await scoreDrop(sbWithPricing(PRICING), base(), listItem(100), 1)
    expect(res.pack_price_usd).toBe(10)
    expect(res.verdict_kind).toBe("value")
  })

  it("ratio <= 0.85 → 'premium' (ask above RPC FMV)", async () => {
    // 200 FLOW / 10 = 20 FLOW * $1 = $20 ask; 13/20 = 0.65
    const res = await scoreDrop(sbWithPricing(PRICING), base(), listItem(200), 1)
    expect(res.verdict_kind).toBe("premium")
  })

  it("0.85 < ratio < 1.15 → 'fair'", async () => {
    // 130 FLOW / 10 = 13 FLOW * $1 = $13 ask; 13/13 = 1.0
    const res = await scoreDrop(sbWithPricing(PRICING), base(), listItem(130), 1)
    expect(res.verdict_kind).toBe("fair")
  })

  it("no USD pack price but a pack EV → 'unknown' with the per-pack value line", async () => {
    const res = await scoreDrop(sbWithPricing(PRICING), base(), null, 1)
    expect(res.pack_price_usd).toBeNull()
    expect(res.verdict_kind).toBe("unknown")
    expect(res.verdict).toContain("per pack")
  })

  it("no flowUsd conversion → pack_price_usd null even with a FLOW listing", async () => {
    const res = await scoreDrop(sbWithPricing(PRICING), base(), listItem(100), null)
    expect(res.pack_price_flow).toBe(10) // 100 / 10 packs
    expect(res.pack_price_usd).toBeNull()
    expect(res.verdict_kind).toBe("unknown")
  })
})
