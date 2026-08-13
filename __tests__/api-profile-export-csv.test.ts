import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/export-csv.
// Session-gated read keyed by ?ownerKey (→ 400 when missing, → guard 401/403
// when the key is not the caller's). Reads saved_wallets by owner_key then
// per-wallet export_wallet_csv RPC, emitting a text/csv body. Pin: the 400
// guard, the requireOwnedKey gate (IDOR guard), the saved_wallets error → 500,
// and a happy path with no wallets (header-only CSV with content-type/disposition).

const state: { wallets: { data: any; error: any }; rows: { data: any; error: any } } = {
  wallets: { data: [], error: null },
  rows: { data: [], error: null },
}

// The ownership guard result: { user } lets the read proceed; a Response short-
// circuits the route (unauthenticated 401 / not-the-caller's-key 403).
const guard: { result: any } = { result: { user: { id: "u1" } } }
vi.mock("@/lib/auth/owner-key-guard", () => ({
  requireOwnedKey: async () => guard.result,
}))

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
  guard.result = { user: { id: "u1" } }
})

describe("GET /api/profile/export-csv", () => {
  it("400s without ownerKey", async () => {
    const res = await GET(req("https://t/api/profile/export-csv"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("401s when the caller is not authenticated (guard denies)", async () => {
    guard.result = new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect(res.status).toBe(401)
  })

  it("403s when ownerKey is not the caller's (IDOR guard)", async () => {
    guard.result = new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=someone-else"))
    expect(res.status).toBe(403)
  })

  it("500s when the saved_wallets lookup errors", async () => {
    state.wallets = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
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

// --- deeper legs: row emission, csvEscape, per-wallet RPC error, outer catch ---

describe("GET /api/profile/export-csv — row emission", () => {
  it("emits one CSV line per moment, per wallet", async () => {
    state.wallets = { data: [{ wallet_addr: "0x1111111111111111" }], error: null }
    state.rows = {
      data: [
        { player_name: "Ja Morant", set_name: "Base Set", series: "S4", tier: "COMMON", serial_number: 12, circulation_count: 15000, fmv: 4.2, buy_price: 3, acquisition_method: "pack", is_locked: true },
        { player_name: "LeBron", set_name: "MGLE", series: "S1", tier: "LEGENDARY", serial_number: 1, circulation_count: 49, fmv: 9000, buy_price: null, acquisition_method: null, is_locked: false },
      ],
      error: null,
    }
    const body = await (await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))).text()
    const lines = body.trim().split("\n")
    expect(lines).toHaveLength(3) // header + 2 moments
    expect(lines[1]).toContain("0x1111111111111111,Ja Morant,Base Set,S4,COMMON,12,15000,4.2,3,pack,true")
    expect(lines[2]).toContain("LeBron")
    expect(lines[2].endsWith(",false")).toBe(true) // is_locked false, not blank
  })

  it("quote-escapes fields containing commas / quotes / newlines", async () => {
    state.wallets = { data: [{ wallet_addr: "0x2222222222222222" }], error: null }
    state.rows = {
      data: [
        { player_name: 'Smith, Jr. "The Kid"', set_name: "Line\nBreak", series: null, tier: null, serial_number: null, circulation_count: null, fmv: null, buy_price: null, acquisition_method: null, is_locked: null },
      ],
      error: null,
    }
    const body = await (await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))).text()
    expect(body).toContain('"Smith, Jr. ""The Kid"""') // comma + doubled quotes
    expect(body).toContain('"Line\nBreak"')
    expect(body).toContain(",,") // null fields render empty
  })

  it("skips a wallet whose export RPC errors but still returns the CSV", async () => {
    state.wallets = { data: [{ wallet_addr: "0x3333333333333333" }], error: null }
    state.rows = { data: null, error: { message: "rpc down" } }
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.text()).trim().split("\n")).toHaveLength(1) // header only
  })

  it("ignores non-string / empty wallet addresses", async () => {
    state.wallets = { data: [{ wallet_addr: null }, { wallet_addr: "" }, { wallet_addr: 42 }], error: null }
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect((await res.text()).trim().split("\n")).toHaveLength(1)
  })

  it("500s when a non-Postgrest error is thrown mid-export", async () => {
    state.wallets = { data: [{ wallet_addr: "0x4444444444444444" }], error: null }
    state.rows = { get data(): any { throw new Error("boom") }, error: null } as any
    const res = await GET(req("https://t/api/profile/export-csv?ownerKey=trevor"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Internal error")
  })
})
