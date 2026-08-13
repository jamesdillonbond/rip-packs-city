import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/portfolio-export (no auth; CSV export).
// Pre-DB guards: 400 without wallet, 400 for an unknown collection slug. Happy
// path returns a text/csv attachment built from get_wallet_moments_with_fmv.
// Mocks @/lib/supabase's supabaseAdmin.rpc.

const rpc: { data: any; error: any } = { data: null, error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: rpc.data, error: rpc.error }) },
}))

import { GET } from "@/app/api/portfolio-export/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  rpc.data = { moments: [] }
  rpc.error = null
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
