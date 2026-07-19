import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Route integration test for /api/candy-sales-indexer. Bearer-gated on
// INGEST_SECRET_TOKEN *or* CRON_SECRET (read at request time via process.env, so
// vi.stubEnv works), with GET + POST both routed through the same handler so the
// Vercel cron (GET, CRON_SECRET) can drive it. Priority is the fail-closed auth
// guard.
//
// As of 2026-07-19 CANDY_MLB_ME_SYMBOL is ARMED (the real, live-verified Magic
// Eden symbol), so an authorized call no longer short-circuits to
// "discovery_pending" — it accepts and schedules the after() sweep. We stub
// next/server's after() so the sweep is captured, never executed: these tests must
// not touch the network. The discovery_pending branch is still covered (against a
// mocked candyMeSymbolReady) in api-candy-sales-indexer-deep.test.ts.

const state = vi.hoisted(() => ({ afterCbs: [] as Array<() => unknown> }))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async () => ({ data: null, error: null }) },
}))

import { GET, POST } from "@/app/api/candy-sales-indexer/route"
import { makeReq } from "./cron-req-helper"

const URL = "https://t/api/candy-sales-indexer"

beforeEach(() => {
  state.afterCbs.length = 0
  vi.stubEnv("INGEST_SECRET_TOKEN", "candy-secret")
  vi.stubEnv("CRON_SECRET", "")
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe("/api/candy-sales-indexer — fail-closed auth", () => {
  it("401s with no Authorization header", async () => {
    const res = await POST(makeReq({ url: URL }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Unauthorized")
    expect(state.afterCbs).toHaveLength(0)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await POST(makeReq({ url: URL, auth: "Bearer nope" }))
    expect(res.status).toBe(401)
  })

  it("401s when both secrets are unset (fail-closed on empty secret)", async () => {
    vi.stubEnv("INGEST_SECRET_TOKEN", "")
    const res = await POST(makeReq({ url: URL, auth: "Bearer candy-secret" }))
    expect(res.status).toBe(401)
  })

  it("does not accept the CRON_SECRET value while CRON_SECRET is unset", async () => {
    const res = await POST(makeReq({ url: URL, auth: "Bearer cron-secret" }))
    expect(res.status).toBe(401)
  })
})

describe("/api/candy-sales-indexer — authorized (ME symbol armed)", () => {
  it("202s accepted via POST with INGEST_SECRET_TOKEN and schedules the sweep", async () => {
    const res = await POST(makeReq({ url: URL, auth: "Bearer candy-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ accepted: true, collection: "candy_mlb" })
    expect(typeof body.started_at).toBe("string")
    expect(state.afterCbs).toHaveLength(1)
  })

  it("202s accepted via GET with CRON_SECRET (the Vercel cron path)", async () => {
    vi.stubEnv("CRON_SECRET", "cron-secret")
    const res = await GET(makeReq({ url: URL, method: "GET", auth: "Bearer cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
    expect(state.afterCbs).toHaveLength(1)
  })
})
