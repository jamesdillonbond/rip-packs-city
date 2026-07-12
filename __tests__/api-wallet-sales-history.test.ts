import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/wallet-sales-history. Two pre-DB 400 guards
// fire before wallet resolution: missing wallet, and an unknown collection slug.
// The sales/pinnacle_sales reads are out of scope. Mocks supabaseAdmin +
// @/lib/topshot.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => ({}) } }))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { GET } from "@/app/api/wallet-sales-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

describe("GET /api/wallet-sales-history — pre-DB guards", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/wallet-sales-history"))).status).toBe(400)
  })
  it("400s on an unknown collection", async () => {
    const res = await GET(req("https://t/api/wallet-sales-history?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
})
