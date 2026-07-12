import { describe, it, expect } from "vitest"

// Route integration test for GET /api/wallet-preflight. Read-only on-chain
// diagnostic with three pre-network 400 guards: an invalid address, an unknown
// collection, and an out-of-range count. No DB and no auth. The Flow REST script
// call is out of scope.

import { GET } from "@/app/api/wallet-preflight/route"

const req = (u: string) => ({ url: u }) as any

describe("GET /api/wallet-preflight — input guards", () => {
  it("400s on a missing/invalid address", async () => {
    expect((await GET(req("https://t/api/wallet-preflight"))).status).toBe(400)
    expect((await GET(req("https://t/api/wallet-preflight?address=nope"))).status).toBe(400)
  })
  it("400s on an unknown collection", async () => {
    expect((await GET(req("https://t/api/wallet-preflight?address=0xbd94cade097e50ac&collection=nope"))).status).toBe(400)
  })
  it("400s on an out-of-range count", async () => {
    expect((await GET(req("https://t/api/wallet-preflight?address=0xbd94cade097e50ac&collection=topshot&count=0"))).status).toBe(400)
    expect((await GET(req("https://t/api/wallet-preflight?address=0xbd94cade097e50ac&collection=topshot&count=5000"))).status).toBe(400)
  })
})
