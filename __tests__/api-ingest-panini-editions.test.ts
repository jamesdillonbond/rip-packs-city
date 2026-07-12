import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for /api/ingest/panini-editions (POST only).
// Same FAIL-CLOSED shape as candy-editions: `if (!expectedToken || header !==
// 'Bearer '+token) → 401`, so a missing INGEST_SECRET_TOKEN 401s. The route is
// INERT until go-live (paniniFeedEnabled() is false without PANINI_FEED_MODE +
// creds), so the authed path short-circuits to a logged 202 feed_inert skip.

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }) },
}))

import { POST } from "@/app/api/ingest/panini-editions/route"

beforeEach(() => {
  vi.unstubAllEnvs()
})

describe("POST /api/ingest/panini-editions", () => {
  it("401s FAIL-CLOSED when INGEST_SECRET_TOKEN is unset (no header)", async () => {
    const res = await POST(makeReq({ url: "https://t/api/ingest/panini-editions" }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
  })

  it("401s when the Bearer token does not match", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(
      makeReq({ url: "https://t/api/ingest/panini-editions", auth: "Bearer wrong" })
    )
    expect(res.status).toBe(401)
  })

  it("202-skips (feed_inert) on a valid token while the feed is unconfigured", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "secret")
    const res = await POST(
      makeReq({ url: "https://t/api/ingest/panini-editions", auth: "Bearer secret" })
    )
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("feed_inert")
  })
})
