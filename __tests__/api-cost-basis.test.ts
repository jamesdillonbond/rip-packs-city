import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/cost-basis. No auth gate — pins the
// `wallet` 400 guard, the empty happy path, the RPC-error → 500, AND (added in
// the 2026-07-28 Gap-C error-leg pass) the previously-dark branches: collection
// resolution to a p_collection_id, the acquisition-enrichment join with its
// first-wins dedup, and the missing-0x normalization. Mocks
// @supabase/supabase-js createClient (the route builds its own service client):
// resolveCollectionId uses .from().select().eq().single(); the reads are
// rpc("get_wallet_cost_basis") + rpc("get_wallet_acquisition_data").

const state: {
  costBasis: { data: any; error: any }
  acq: { data: any; error: any }
  configRow: any
  configError: any
  rpcCalls: Array<{ fn: string; params: any }>
} = {
  costBasis: { data: [], error: null },
  acq: { data: null, error: null },
  configRow: null,
  configError: null,
  rpcCalls: [],
}

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    single: async () => ({ data: state.configRow, error: state.configError }),
  }
  return {
    createClient: () => ({
      from: () => b,
      rpc: async (fn: string, params: any) => {
        state.rpcCalls.push({ fn, params })
        if (fn === "get_wallet_acquisition_data") return state.acq
        return state.costBasis
      },
    }),
  }
})

import { GET } from "@/app/api/cost-basis/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.costBasis = { data: [], error: null }
  state.acq = { data: null, error: null }
  state.configRow = null
  state.configError = null
  state.rpcCalls = []
})

describe("GET /api/cost-basis", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/cost-basis"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("returns an empty acquisitions list when the RPC yields no rows", async () => {
    state.costBasis = { data: [], error: null }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xdeadbeef00000000"))
    expect(res.status).toBe(200)
    expect((await res.json()).acquisitions).toEqual([])
    // no nft_ids → the enrichment RPC must NOT be called
    expect(state.rpcCalls.map((c) => c.fn)).toEqual(["get_wallet_cost_basis"])
  })

  it("500s on an RPC error", async () => {
    state.costBasis = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xdeadbeef00000000"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })

  it("normalizes a wallet with no 0x prefix before the RPC", async () => {
    await GET(req("https://t/api/cost-basis?wallet=deadbeef00000000"))
    expect(state.rpcCalls[0].params.p_wallet).toBe("0xdeadbeef00000000")
  })

  it("resolves a known collection slug to p_collection_id", async () => {
    // getCollection("nfl-all-day").flowContractName resolves; config row supplies id.
    state.configRow = { collection_id: "col-allday" }
    await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000&collection=nfl-all-day"))
    expect(state.rpcCalls[0].params.p_collection_id).toBe("col-allday")
  })

  it("does not pass p_collection_id for an unknown collection slug", async () => {
    await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000&collection=not-a-collection"))
    expect(state.rpcCalls[0].params.p_collection_id).toBeUndefined()
  })

  it("does NOT silently widen the scope when the collection lookup fails", async () => {
    // The defect this pins is not an empty answer, it is a DIFFERENT one.
    // resolveCollectionId returned `string | null`, and the caller reads null as
    // "no collection filter was asked for" — so a failed collection_config read
    // dropped p_collection_id and the RPC returned EVERY collection the wallet
    // holds, rendered inside a single-collection tab, about the reader's own money.
    //
    // The load-bearing assertion is the second one: a 500 alone would also be
    // satisfied by code that still fired the unscoped query first.
    state.configError = { message: "statement timeout" }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000&collection=nfl-all-day"))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(
      state.rpcCalls.find((c) => c.fn === "get_wallet_cost_basis"),
      "the unscoped cost-basis RPC must never be issued after a failed scope lookup",
    ).toBeUndefined()
  })

  it("still answers unscoped when NO collection was requested at all", async () => {
    // The control that keeps the fix honest. Without it, "500 when id is null"
    // would break the legitimate all-collections call the same helper serves —
    // turning a real feature into an error page.
    const res = await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000"))
    expect(res.status).toBe(200)
    expect(state.rpcCalls[0].params.p_collection_id).toBeUndefined()
  })

  it("enriches each row with acquisition_method, first-wins on duplicate moment_id", async () => {
    state.costBasis = {
      data: [
        { nft_id: "n1", cost_usd: 10 },
        { nft_id: "n2", cost_usd: 20 },
        { nft_id: null, cost_usd: 5 }, // filtered out of the id list
      ],
      error: null,
    }
    state.acq = {
      data: [
        { moment_id: "n1", acquisition_method: "pack_pull" },
        { moment_id: "n1", acquisition_method: "secondary" }, // dup — ignored (first wins)
        { moment_id: "n2", acquisition_method: "gift" },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000"))
    const body = await res.json()
    expect(body.acquisitions[0].acquisition_method).toBe("pack_pull")
    expect(body.acquisitions[1].acquisition_method).toBe("gift")
    // a row whose moment_id had no acquisition row gets null, not undefined
    expect(body.acquisitions[2].acquisition_method).toBeNull()
    // enrichment RPC only receives the non-null nft_ids
    const acqCall = state.rpcCalls.find((c) => c.fn === "get_wallet_acquisition_data")
    expect(acqCall?.params.p_moment_ids).toEqual(["n1", "n2"])
  })

  it("still returns rows when the acquisition enrichment yields nothing", async () => {
    state.costBasis = { data: [{ nft_id: "n1", cost_usd: 10 }], error: null }
    state.acq = { data: null, error: null }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000"))
    const body = await res.json()
    expect(res.status).toBe(200)
    // acqData null → no acquisition_method key added at all
    expect(body.acquisitions[0].acquisition_method).toBeUndefined()
  })

  it("sends a private cache header on the success path", async () => {
    const res = await GET(req("https://t/api/cost-basis?wallet=0xabc0000000000000"))
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60")
  })
})
