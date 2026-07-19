import { describe, it, expect, vi } from "vitest"

// Route integration test for GET /api/owned-flow-ids?wallet=0x...
// The happy path runs FCL Cadence queries against Flow mainnet (no simple mock
// seam), so this pins only the two pre-FCL guards: missing wallet → 400, and a
// non-Flow-address wallet → 400. FCL/collections are mocked to no-ops purely so
// the module imports cleanly; the guards return before either is used.
// NOTE: deeper coverage is import-only — the resolve path is fcl.query()-driven.

vi.mock("@/lib/chains/flow/flow", () => ({ default: { query: async () => [] } }))
vi.mock("@onflow/types", () => ({ Address: "Address" }))
vi.mock("@/lib/collections", () => ({ getCollection: () => undefined }))

import { GET } from "@/app/api/owned-flow-ids/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

describe("GET /api/owned-flow-ids", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/owned-flow-ids"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet query param is required")
  })

  it("400s on a wallet that is not a Flow 0x address", async () => {
    const res = await GET(req("https://t/api/owned-flow-ids?wallet=notanaddress"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet must be a Flow 0x address")
  })

  it("is a function (export shape)", () => {
    expect(typeof GET).toBe("function")
  })
})
