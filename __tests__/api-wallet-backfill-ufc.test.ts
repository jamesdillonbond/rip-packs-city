import { describe, it, expect, vi } from "vitest"

// Route integration test for POST /api/wallet-backfill-ufc. Bearer
// INGEST_SECRET_TOKEN gated → fail-closed 401. The UFC Cadence walk runs in
// after() and is out of scope. Mocks supabaseAdmin + wallet-backfill-helpers.

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { rpc: async () => ({ data: null, error: null }), from: () => ({}) } }))
vi.mock("@/lib/wallet-backfill-helpers", async (importOriginal) => ({
  ...(await importOriginal<any>()),
  isStorageLimitError: () => false,
  isNoCollectionCapabilityError: () => false,
}))

import { POST } from "@/app/api/wallet-backfill-ufc/route"

const req = (headers: Record<string, string> = {}, body: any = {}) =>
  ({ headers: new Headers(headers), json: async () => body }) as any

describe("POST /api/wallet-backfill-ufc — fail-closed auth", () => {
  it("401s without the bearer token", async () => {
    expect((await POST(req())).status).toBe(401)
  })
  it("401s with a bogus token", async () => {
    expect((await POST(req({ authorization: "Bearer x" }))).status).toBe(401)
  })
})
