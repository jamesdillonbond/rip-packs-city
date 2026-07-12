import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/wallet-backfill-candy (Solana/Candy). Bearer
// INGEST_SECRET_TOKEN gated → fail-closed 401. The DAS ownership walk runs in
// after() and is out of scope. Mocks supabaseAdmin + the Solana DAS/normalize libs.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))
vi.mock("@/lib/chains/solana/das", () => ({ paginateOwner: async () => [] }))
vi.mock("@/lib/chains/solana/normalize", () => ({
  normalizeCandyAsset: () => ({}),
  isCandyAsset: () => false,
}))

import { POST } from "@/app/api/wallet-backfill-candy/route"

const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill-candy — fail-closed auth", () => {
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})
