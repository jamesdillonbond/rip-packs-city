import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/candy-editions (POST only).
// FAIL-CLOSED auth is the priority: the guard is
// `if (!expectedToken || authHeader !== 'Bearer '+token) -> 401`, so a MISSING
// INGEST_SECRET_TOKEN (the vitest default) 401s rather than running.
// Post-discovery (2026-07-17) CANDY_MLB_COLLECTION_ADDRESS is filled, so a valid
// token no longer short-circuits discovery_pending — it accepts and defers the
// DAS walk to after() (mocked to a no-op here).

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }) },
}))

import { POST } from "@/app/api/ingest/candy-editions/route"

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/ingest/candy-editions", () => {
  it("401s FAIL-CLOSED when INGEST_SECRET_TOKEN is unset (no header)", async () => {
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

  it("202-accepts on a valid token now that discovery is ready (DAS walk deferred to after())", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(
      makeReq({ url: "https://t/api/ingest/candy-editions", auth: "Bearer secret" })
    )
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("candy_mlb")
  })
})
