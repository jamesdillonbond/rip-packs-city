import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/wallet-backfill-multicollection. Bearer
// INGEST_SECRET_TOKEN gated → fail-closed 401. The per-collection fan-out (via
// fetch to the sibling backfill routes) runs in after() and is out of scope.
// Mocks supabaseAdmin.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))

import { POST } from "@/app/api/wallet-backfill-multicollection/route"

const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body, url: "https://t/api/wallet-backfill-multicollection" }) as any

describe("POST /api/wallet-backfill-multicollection — fail-closed auth", () => {
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})
