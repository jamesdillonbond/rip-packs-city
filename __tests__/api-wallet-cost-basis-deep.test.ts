import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Deep-drive of GET /api/wallet-cost-basis — per-moment P&L for a TopShot wallet.
// No existing suite. We drive the full fold and assert the COMPUTED contract:
//   - summary (tracked_count / total_cost_basis / total_current_fmv / total_pnl_usd
//     / total_pnl_pct / win_count / loss_count) derived from buy_price vs FMV;
//   - top_movers gainers/losers ordering + the sample_size_note tracked/total ratio;
//   - non-TopShot collections short-circuit to reason 'cost_basis_unavailable';
//   - a TopShot wallet with no tracked acquisitions -> 'no_tracked_acquisitions';
//   - the wallet-missing (400) and unknown-collection (400) guards;
//   - username resolution routed through the TopShot GQL profile lookup.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gql: (() => ({})) as () => unknown,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => state.gql() }))

const { GET } = await import("@/app/api/wallet-cost-basis/route")

const WALLET = "0xbd94cade097e50ac" // 18 chars -> resolveWallet returns as-is

function req(qs: string): NextRequest {
  return new NextRequest("https://t/api/wallet-cost-basis?" + qs)
}
function install(fixtures: Parameters<typeof makeSupabaseFixture>[0]) {
  state.sb = makeSupabaseFixture(fixtures)
}

beforeEach(() => {
  state.gql = () => ({})
})

describe("wallet-cost-basis — P&L fold", () => {
  it("computes the summary + top movers from buy_price vs FMV", async () => {
    install({
      moment_acquisitions: [
        { data: [{ nft_id: "111", buy_price: 10 }, { nft_id: "222", buy_price: 100 }], error: null },
        { count: 5, error: null } as never, // total-acq count for the sample note
      ],
      wallet_moments_cache: {
        data: [
          { moment_id: "111", edition_key: "3:45", player_name: "Dame", set_name: "Base", tier: "RARE", serial_number: 5 },
          { moment_id: "222", edition_key: "7:77", player_name: "CJ", set_name: "Base", tier: "COMMON", serial_number: 100 },
        ],
        error: null,
      },
      editions: {
        data: [
          { id: "edA", external_id: "3:45", tier: "RARE", player_name: "Damian", set_name: "Base Set" },
          { id: "edB", external_id: "7:77", tier: "COMMON", player_name: "CJ", set_name: "Base Set" },
        ],
        error: null,
      },
      "rpc:get_fmv_for_editions": {
        data: [
          { edition_id: "edA", fmv_usd: 50 }, // buy 10 -> +40 (+400%) win
          { edition_id: "edB", fmv_usd: 40 }, // buy 100 -> -60 (-60%) loss
        ],
        error: null,
      },
    })

    const res = await GET(req("wallet=" + WALLET + "&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.summary).toMatchObject({
      tracked_count: 2,
      total_cost_basis: 110,
      total_current_fmv: 90,
      total_pnl_usd: -20,
      total_pnl_pct: -18.2,
      win_count: 1,
      loss_count: 1,
    })
    expect(body.top_movers.gainers[0]).toMatchObject({ player_name: "Damian", pnl_pct: 400 })
    expect(body.top_movers.losers[0]).toMatchObject({ pnl_pct: -60 })
    expect(body.sample_size_note).toContain("tracked on 2 of 5 moments")
    // pnl_usd is stripped from the mover rows (internal sort key only).
    expect("pnl_usd" in body.top_movers.gainers[0]).toBe(false)
  })

  it("short-circuits non-TopShot collections to cost_basis_unavailable", async () => {
    install({})
    const res = await GET(req("wallet=" + WALLET + "&collection=nfl-all-day"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ collection: "nfl-all-day", rows: [], reason: "cost_basis_unavailable" })
  })

  it("returns no_tracked_acquisitions when the wallet has no priced buys", async () => {
    install({
      moment_acquisitions: [
        { data: [], error: null }, // no buy_price>0 acquisitions
        { count: 0, error: null } as never,
      ],
    })
    const res = await GET(req("wallet=" + WALLET + "&collection=nba-top-shot"))
    const body = await res.json()
    expect(body.reason).toBe("no_tracked_acquisitions")
    expect(body.rows).toEqual([])
  })

  it("400s when the wallet param is missing", async () => {
    install({})
    const res = await GET(req("collection=nba-top-shot"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s on an unknown collection slug", async () => {
    install({})
    const res = await GET(req("wallet=" + WALLET + "&collection=bogus"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("unknown collection")
  })

  it("resolves a username through the TopShot GQL profile lookup", async () => {
    state.gql = () => ({ getUserProfileByUsername: { publicInfo: { flowAddress: WALLET } } })
    install({
      moment_acquisitions: [
        { data: [], error: null },
        { count: 0, error: null } as never,
      ],
    })
    const res = await GET(req("wallet=damian&collection=nba-top-shot"))
    const body = await res.json()
    expect(body.wallet).toBe(WALLET) // username -> resolved flow address
    expect(body.reason).toBe("no_tracked_acquisitions")
  })
})
