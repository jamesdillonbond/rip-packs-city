import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/export-csv.
// Public read keyed by ?ownerKey (→ 400 when missing). Reads saved_wallets by
// owner_key then per-wallet export_wallet_csv RPC, emitting a text/csv body.
// Pin: the 400 guard, the saved_wallets error → 500, and a happy path with no
// wallets (header-only CSV with the expected content-type + disposition).

const state: { wallets: { data: any; error: any }; rows: { data: any; error: any } } = {
  wallets: { data: [], error: null },
  rows: { data: [], error: null },
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => chain(() => state.wallets),
    rpc: async () => state.rows,
  },
}))

import { GET } from "@/app/api/profile/export-csv/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.wallets = { data: [], error: null }
  state.rows = { data: [], error: null }
})

describe("GET /api/profile/export-csv", () => {
  it("400s without ownerKey", async () => {
    const res = await GET(req("https://t/api/profile/export-csv"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("500s when the saved_wallets lookup errors", async () => {
    state.wallets = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("returns a header-only CSV when the owner has no wallets", async () => {
    state.wallets = { data: [], error: null }
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/csv")
    expect(res.headers.get("Content-Disposition")).toContain("rpc-collection-export.csv")
    const body = await res.text()
    expect(body.startsWith("Wallet,Player,Set,Series,Tier,Serial,Mint Size,FMV,Buy Price,Acquisition Method,Locked")).toBe(true)
  })
})
