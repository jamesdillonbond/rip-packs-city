import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

// app/api/public/trades/compare/route.ts (2026-11-16): names refused by name, a failed chain
// read is a 503 (never a list of unverified Moments), no wallet or confidence tier in the body.

const rates = vi.hoisted(() => ({ allowed: true, failed: false, refusedBucket: null as string | null }))
const resolveMock = vi.hoisted(() => vi.fn())
const readCandidates = vi.hoisted(() => vi.fn())
const readChain = vi.hoisted(() => vi.fn())
const readOnChainCount = vi.hoisted(() => vi.fn())

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) },
}))
vi.mock("@/lib/abuse/anon-rate", () => ({
  anonIpKey: () => "1.2.3.4",
  bumpAnonRates: async () => ({ ...rates, count: 1 }),
}))
vi.mock("@/lib/chains/flow/topshot-username-resolve", () => ({
  isWalletAddress: (v: string) => /^0x[a-fA-F0-9]{16}$/.test(v.trim()),
  resolveTopShotUsernameCacheAware: resolveMock,
}))
vi.mock("@/lib/trade-compare/read", () => ({ readCandidates, readChain, readOnChainCount, CANDIDATE_LIMIT: 600 }))

import { GET } from "@/app/api/public/trades/compare/route"

const A = "0xbd94cade097e50ac"
const B = "0x01d7e57aa5598e47"

function req(q: string) {
  return new NextRequest(`https://www.rippackscity.com/api/public/trades/compare?${q}`)
}

function cand(id: string, ek: string, fmv: number, conf = "HIGH") {
  return { moment_id: id, edition_key: ek, serial_number: Number(id), player_name: "P", set_name: "S", tier: "RARE", series_number: 8, image_url: null, league: "NBA", fmv_usd: fmv, fmv_confidence: conf, owned: 2, cached_locked: 0 }
}

beforeEach(() => {
  rates.allowed = true
  rates.failed = false
  rates.refusedBucket = null
  resolveMock.mockReset()
  resolveMock.mockImplementation(async (_db: unknown, u: string) =>
    u.toLowerCase() === "jamesdillonbond" ? { found: true, walletAddress: A, username: "Jamesdillonbond" } : u === "roham" ? { found: true, walletAddress: B, username: "roham" } : { found: false, reason: "username_not_found_on_topshot" },
  )
  readCandidates.mockReset()
  readCandidates.mockResolvedValue({ a_indexed: 10, b_indexed: 10, a_total: 1, b_total: 1, a_rows: [cand("11", "x", 6)], b_rows: [cand("22", "y", 6.5)] })
  readChain.mockReset()
  readChain.mockImplementation(async (_a: string, rows: Array<{ moment_id: string }>) => ({
    holdings: Object.fromEntries(rows.map((r) => [r.moment_id, { held: true, locked: false }])),
    listed: new Set(),
  }))
  readOnChainCount.mockReset()
  readOnChainCount.mockResolvedValue(10)
})

describe("GET /api/public/trades/compare", () => {
  it("matches usernames case-insensitively and answers with the canonical spelling, a Quick Trade, and no wallet or tier", async () => {
    const r = await GET(req("u1=jamesdillonbond&u2=roham"))
    expect(r.status).toBe(200)
    const body = await r.json()
    expect(body.a.username).toBe("Jamesdillonbond")
    expect(body.quick_trade.a.moment_id).toBe("11")
    const text = JSON.stringify(body)
    expect(text).not.toContain(A)
    expect(text).not.toContain(B)
    expect(text).not.toMatch(/confidence|"HIGH"|"MEDIUM"/)
  })

  it("an unknown username is a 404 by name, never an empty comparison", async () => {
    const r = await GET(req("u1=jamesdillonbond&u2=nobodyhere"))
    expect(r.status).toBe(404)
    expect((await r.json()).error).toMatch(/nobodyhere/)
    expect(readCandidates).not.toHaveBeenCalled()
  })

  it("a FAILED username lookup is a 503, never 'no such user'", async () => {
    resolveMock.mockResolvedValueOnce({ found: false, reason: "topshot_gql_error", detail: "atlas down" })
    const r = await GET(req("u1=jamesdillonbond&u2=roham"))
    expect(r.status).toBe(503)
  })

  it("a failed chain read is a 503 — no unverified Moment is ever shown as tradeable", async () => {
    readChain.mockRejectedValueOnce(new Error("Flow script HTTP 503"))
    const r = await GET(req("u1=jamesdillonbond&u2=roham"))
    expect(r.status).toBe(503)
    expect(JSON.stringify(await r.json())).not.toMatch(/editions/)
  })

  it("the same collector twice is refused", async () => {
    const r = await GET(req("u1=jamesdillonbond&u2=Jamesdillonbond"))
    expect(r.status).toBe(400)
  })

  it("bad input is refused before any read", async () => {
    const r = await GET(req("u1=jamesdillonbond&u2=a%20b"))
    expect(r.status).toBe(400)
    expect(resolveMock).not.toHaveBeenCalled()
  })

  it("rate limited is a 429; an unreadable counter fails CLOSED as a 503", async () => {
    rates.allowed = false
    rates.refusedBucket = "trade_compare:ip"
    expect((await GET(req("u1=jamesdillonbond&u2=roham"))).status).toBe(429)
    rates.failed = true
    expect((await GET(req("u1=jamesdillonbond&u2=roham"))).status).toBe(503)
  })

  it("a short index is reported as incomplete; an unreadable chain count is unknown, not complete", async () => {
    readOnChainCount.mockImplementation(async (addr: string) => (addr === A ? 15 : null))
    const body = await (await GET(req("u1=jamesdillonbond&u2=roham"))).json()
    expect(body.a.coverage).toEqual({ indexed: 10, on_chain: 15, complete: false })
    expect(body.b.coverage.complete).toBeNull()
  })
})
