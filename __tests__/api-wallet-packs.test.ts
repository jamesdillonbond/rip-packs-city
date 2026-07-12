import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/wallet-packs. Requires ?wallet= → 400
// before any GraphQL work. The upstream Studio pack-aggregation walk is out of
// scope. Mocks @/lib/topshot (topshotGraphql) so the import is pure.

vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { GET } from "@/app/api/wallet-packs/route"

const req = (u: string) => ({ url: u }) as any

describe("GET /api/wallet-packs", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/wallet-packs"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param required")
  })
})
