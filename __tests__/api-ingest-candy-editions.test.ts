import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/candy-editions (POST only).
// FAIL-CLOSED auth is the priority: the guard is
// `if (!expectedToken || authHeader !== 'Bearer '+token) → 401`, so a MISSING
// INGEST_SECRET_TOKEN (the vitest default) 401s rather than running. The route
// is also INERT (candyDiscoveryReady() is false — CANDY_MLB_COLLECTION_ADDRESS
// is a TODO placeholder), so the authed path short-circuits to a logged 202.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }) },
}))

import { POST } from "@/app/api/ingest/candy-editions/route"

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/ingest/candy-editions", () => {
  it("401s FAIL-CLOSED when INGEST_SECRET_TOKEN is unset (no header)", async () => {
    // vitest.setup does not set INGEST_SECRET_TOKEN → !expectedToken → 401.
    const res = await POST(makeReq({ url: "https://t/api/ingest/candy-editions" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s when the Bearer token does not match", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(
      makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer wrong" })
    )
    expect(res.status).toBe(401)
  })

  it("202-skips (discovery_pending) on a valid token while the collection is inert", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(
      makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" })
    )
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("discovery_pending")
  })
})
