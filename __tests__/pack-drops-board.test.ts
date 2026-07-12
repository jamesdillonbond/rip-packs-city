import { describe, it, expect, vi } from "vitest"
import { scoreDrop } from "@/lib/pack-drops-board"
import type {
  VaultopolisComposition,
  VaultopolisAsset,
  VaultopolisDropListItem,
} from "@/lib/pack-drops-board"

// Pins lib/pack-drops-board.ts::scoreDrop — the Vaultopolis re-pack scoring core
// behind the public /insights/pack-drops board. scoreDrop is the pure-compute
// half (its only I/O is the get_pack_drop_pricing RPC, injected via the Supabase
// client), so it can be driven directly with a fake `sb`. These lock down the
// (player,set,series) rollup, the RPC-FMV-vs-their-estimate pool math, value
// concentration, pack EV, and the value/premium/fair/unknown verdict ladder.

function asset(over: Partial<VaultopolisAsset> = {}): VaultopolisAsset {
  return {
    nftId: 1,
    valueTier: "Common",
    playerName: "Damian Lillard",
    setName: "Base Set",
    serialNumber: 1,
    momentCount: 1,
    series: 4,
    tier: "common",
    estimatedValue: 10,
    floorPrice: null,
    ...over,
  }
}

function comp(assets: VaultopolisAsset[], over: Partial<VaultopolisComposition> = {}): VaultopolisComposition {
  return {
    dropId: 7,
    name: "Test Drop",
    displayName: "Test Drop",
    description: "d",
    packCount: 10,
    nftsPerPack: 5,
    totalNfts: 50,
    openedCount: 0,
    status: "live",
    assets: { TopShot: assets },
    ...over,
  }
}

// Fake Supabase whose rpc returns the given pricing rows (or an error).
function fakeSb(rows: any[] | null, error: { message: string } | null = null): any {
  return { rpc: vi.fn(async () => ({ data: rows, error })) }
}

describe("scoreDrop — rollup & matching", () => {
  it("rolls duplicate (player,set,series) into one row with a count", async () => {
    const c = comp([asset(), asset({ nftId: 2 }), asset({ nftId: 3, playerName: "Anthony Edwards" })])
    const sb = fakeSb([]) // no RPC matches → all fall back to their_est
    const s = await scoreDrop(sb, c, null, null)
    expect(s.total_distinct).toBe(2)
    const lillard = s.rows.find((r) => r.player === "Damian Lillard")!
    expect(lillard.count).toBe(2)
  })

  it("prices matched editions off RPC FMV and unmatched off their estimate", async () => {
    const c = comp([
      asset({ playerName: "Damian Lillard", estimatedValue: 10 }),
      asset({ nftId: 2, playerName: "Anthony Edwards", estimatedValue: 20 }),
    ])
    // Only Lillard matches, priced at RPC FMV 100.
    const sb = fakeSb([
      { player: "Damian Lillard", setname: "Base Set", series: 4, edition_matches: 2, rpc_fmv_avg: 100, rpc_fmv_min: 90, rpc_fmv_max: 110, confidence: "HIGH" },
    ])
    const s = await scoreDrop(sb, c, null, null)
    expect(s.matched_count).toBe(1)
    const lillard = s.rows.find((r) => r.player === "Damian Lillard")!
    const edwards = s.rows.find((r) => r.player === "Anthony Edwards")!
    expect(lillard.matched).toBe(true)
    expect(lillard.rpc_fmv_avg).toBe(100)
    expect(lillard.used_fallback).toBe(false)
    expect(edwards.matched).toBe(false)
    expect(edwards.used_fallback).toBe(true)
    // pool = 100 (Lillard) + 20 (Edwards fallback) = 120
    expect(s.rpc_pool_usd).toBe(120)
  })

  it("a zero-match RPC row is treated as unmatched (falls back to their_est)", async () => {
    const c = comp([asset({ estimatedValue: 15 })])
    const sb = fakeSb([
      { player: "Damian Lillard", setname: "Base Set", series: 4, edition_matches: 0, rpc_fmv_avg: 999, rpc_fmv_min: null, rpc_fmv_max: null, confidence: null },
    ])
    const s = await scoreDrop(sb, c, null, null)
    expect(s.matched_count).toBe(0)
    expect(s.rows[0].used_fallback).toBe(true)
    expect(s.rpc_pool_usd).toBe(15)
  })

  it("an RPC error degrades to their-estimate pricing without throwing", async () => {
    const c = comp([asset({ estimatedValue: 12 })])
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    const sb = fakeSb(null, { message: "boom" })
    const s = await scoreDrop(sb, c, null, null)
    expect(s.matched_count).toBe(0)
    expect(s.rpc_pool_usd).toBe(12)
    errSpy.mockRestore()
  })
})

describe("scoreDrop — pool derivatives", () => {
  it("computes pack EV, value concentration and sorts rows by contribution", async () => {
    const c = comp(
      [
        asset({ playerName: "A", estimatedValue: 10 }),
        asset({ nftId: 2, playerName: "B", estimatedValue: 90 }),
      ],
      { packCount: 2 },
    )
    const sb = fakeSb([]) // fallback pricing: A=10, B=90, pool=100
    const s = await scoreDrop(sb, c, null, null)
    expect(s.rpc_pool_usd).toBe(100)
    expect(s.rpc_pack_ev_usd).toBe(50) // 100 / 2 packs
    expect(s.value_concentration_pct).toBe(90) // top edition (B) is 90/100
    expect(s.rows[0].player).toBe("B") // sorted desc by contribution
  })

  it("flags parallels via the parallel flag or a positive subedition id", async () => {
    const c = comp([
      asset({ playerName: "A", parallel: true }),
      asset({ nftId: 2, playerName: "B", subeditionId: 4 }),
    ])
    const s = await scoreDrop(fakeSb([]), c, null, null)
    expect(s.has_parallel).toBe(true)
    expect(s.rows.every((r) => r.is_parallel)).toBe(true)
  })
})

describe("scoreDrop — verdicts", () => {
  const listItem = (listingPrice: number | null): VaultopolisDropListItem => ({
    dropId: 7,
    displayName: "Test Drop",
    status: "live",
    packCount: 10,
    openedCount: 0,
    listedCount: null,
    purchasedCount: null,
    listingPrice,
    listingCurrency: "flow",
  })

  it("value verdict when pack EV exceeds the USD ask by >=15%", async () => {
    // 10 assets each est 10 → pool 100 over 10 packs → EV 10/pack.
    // listing 50 FLOW / 10 packs = 5 FLOW * flowUsd 1 = $5 ask. 10/5 = 2.0 ratio.
    const c = comp(Array.from({ length: 10 }, (_, i) => asset({ nftId: i, playerName: `P${i}` })), { packCount: 10 })
    const s = await scoreDrop(fakeSb([]), c, listItem(50), 1)
    expect(s.verdict_kind).toBe("value")
    expect(s.pack_price_usd).toBe(5)
  })

  it("premium verdict when the ask is well above pack EV", async () => {
    const c = comp(Array.from({ length: 10 }, (_, i) => asset({ nftId: i, playerName: `P${i}` })), { packCount: 10 })
    // listing 2000 FLOW / 10 = 200 FLOW * 1 = $200 ask vs $10 EV → ratio 0.05
    const s = await scoreDrop(fakeSb([]), c, listItem(2000), 1)
    expect(s.verdict_kind).toBe("premium")
  })

  it("fair verdict in the neutral band", async () => {
    const c = comp(Array.from({ length: 10 }, (_, i) => asset({ nftId: i, playerName: `P${i}` })), { packCount: 10 })
    // ask ≈ EV: listing 100 FLOW / 10 = 10 FLOW * 1 = $10 vs $10 EV → ratio 1.0
    const s = await scoreDrop(fakeSb([]), c, listItem(100), 1)
    expect(s.verdict_kind).toBe("fair")
  })

  it("unknown verdict when no FLOW price is published", async () => {
    const c = comp([asset()])
    const s = await scoreDrop(fakeSb([]), c, listItem(null), 1)
    expect(s.verdict_kind).toBe("unknown")
    expect(s.pack_price_usd).toBeNull()
  })

  it("unknown verdict when FLOW/USD rate is missing (EV known, no USD ask)", async () => {
    const c = comp([asset()], { packCount: 5 })
    const s = await scoreDrop(fakeSb([]), c, listItem(50), null)
    expect(s.verdict_kind).toBe("unknown")
    expect(s.verdict).toMatch(/per pack/)
  })
})
