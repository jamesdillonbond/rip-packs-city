import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/portfolio-export (no auth; CSV export).
// Pre-DB guards: 400 without wallet, 400 for an unknown collection slug. Happy
// path returns a text/csv attachment built from get_wallet_moments_with_fmv.
// Mocks @/lib/supabase's supabaseAdmin.rpc.

const rpc: { data: any; error: any; lastArgs: any } = { data: null, error: null, lastArgs: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_n: string, args: any) => { rpc.lastArgs = args; return { data: rpc.data, error: rpc.error } } },
}))

import { GET } from "@/app/api/portfolio-export/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = { moments: [] }
  rpc.error = null
  rpc.lastArgs = null
})

describe("GET /api/portfolio-export", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/portfolio-export"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("400s for an unknown collection slug", async () => {
    const res = await GET(req("https://t/api/portfolio-export?wallet=0xabc&collection=nope"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("500s on an RPC error", async () => {
    rpc.error = { message: "db down" }
    const res = await GET(req("https://t/api/portfolio-export?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("db down")
  })

  it("returns a CSV attachment with a header row and one moment row", async () => {
    rpc.data = {
      moments: [
        { player_name: "Damian Lillard", set_name: "Base", tier: "RARE", serial_number: 7, fmv_usd: 100 },
      ],
    }
    const res = await GET(req("https://t/api/portfolio-export?wallet=0xABC"))
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/csv")
    expect(res.headers.get("Content-Disposition")).toContain("attachment")
    const csv = await res.text()
    const lines = csv.split("\n")
    expect(lines[0]).toContain("Player")
    expect(lines[1]).toContain("Damian Lillard")
    expect(lines[1]).toContain("100.00")
  })
})

// ⛔ THE EXPORT BUTTON ON THE TAB THAT SHIPPED FOR CANDY EARLIER THE SAME DAY.
// `get_wallet_moments_with_fmv` does not fold its wallet (its only `lower()`
// calls are on player_name and tier), so the route's `.toLowerCase()` was the
// whole defect. 📏 Measured live 2026-09-19 on a real Candy wallet: correct
// key → 1,726 moments, lowercased → 0. The reader would have been handed an
// EMPTY CSV, with the mangled address in the filename.
describe("GET /api/portfolio-export — a Candy wallet exports its own moments", () => {
  const MINT = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"

  it("passes the base58 wallet through CASE-INTACT", async () => {
    rpc.data = { moments: [] }
    await GET(req(`https://t/api/portfolio-export?wallet=${MINT}&collection=candy-mlb`))
    expect(rpc.lastArgs?.p_wallet).toBe(MINT)
  })

  it("⛔ the collection set comes from the REGISTRY, not a hardcoded four-slug map", async () => {
    // The old map listed nba-top-shot / nfl-all-day / laliga-golazos /
    // disney-pinnacle, so the Export button answered 400 "Unknown collection"
    // on UFC (published long before) and on Candy — from a control the reader
    // can see. A hardcoded allowlist beside a registry goes stale silently.
    rpc.data = { moments: [] }
    for (const slug of ["candy-mlb", "ufc"]) {
      const res = await GET(req(`https://t/api/portfolio-export?wallet=${MINT}&collection=${slug}`))
      expect(res.status, slug).toBe(200)
    }
  })

  it("⚠ but it does NOT widen to collections with no Collection tab", async () => {
    // The gate is `published && pages.includes("collection")`, so the route's
    // surface is exactly the set of buttons that can call it. Without this arm,
    // swapping a map for a registry lookup quietly exposes Panini and RWA.
    rpc.data = { moments: [] }
    for (const slug of ["panini-blockchain", "rwa"]) {
      const res = await GET(req(`https://t/api/portfolio-export?wallet=0xabcdef1234567890&collection=${slug}`))
      expect(res.status, slug).toBe(400)
    }
  })

  it("no-change control: a Flow wallet is still folded", async () => {
    rpc.data = { moments: [] }
    await GET(req("https://t/api/portfolio-export?wallet=0xABCDEF1234567890&collection=nba-top-shot"))
    expect(rpc.lastArgs?.p_wallet).toBe("0xabcdef1234567890")
  })
})
