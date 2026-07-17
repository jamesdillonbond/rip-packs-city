import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/candy-editions (GET + POST).
// FAIL-CLOSED auth is the priority: the guard accepts Bearer INGEST_SECRET_TOKEN
// OR Bearer CRON_SECRET, so with NEITHER env set (the vitest default) any request
// 401s rather than running. The GET handler exists so the daily Vercel cron
// (which invokes via GET with Bearer CRON_SECRET) can drive the refresh.
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

import { GET, POST } from "@/app/api/ingest/candy-editions/route"

beforeEach(() => {
  vi.unstubAllEnvs()
  // Neither auth secret set by default -> FAIL-CLOSED. Force CRON_SECRET off so a
  // local .env value can't accidentally green a fail-closed assertion.
  vi.stubEnv("CRON_SECRET", "")
})

describe("POST /api/ingest/candy-editions", () => {
  it("401s FAIL-CLOSED when no auth secret is set (no header)", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
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

  it("202-accepts on a valid INGEST token now that discovery is ready (DAS walk deferred to after())", async () => {
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

describe("GET /api/ingest/candy-editions (Vercel cron path)", () => {
  it("401s FAIL-CLOSED when no auth secret is set", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    const res = await GET(
      makeReq({ url: "https://t/api/ingest/candy-editions", method: "GET" })
    )
    expect(res.status).toBe(401)
  })

  it("202-accepts on a valid Bearer CRON_SECRET (how the Vercel cron drives it)", async () => {
    vi.stubEnv("CRON_SECRET", "cronsecret")
    const res = await GET(
      makeReq({
        url: "https://t/api/ingest/candy-editions",
        method: "GET",
        auth: "Bearer cronsecret",
      })
    )
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("candy_mlb")
  })
})
