import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for POST /api/cron/panini-fmv-recalc.
// Fail-closed auth (read at REQUEST time): authed() accepts Bearer
// INGEST_SECRET_TOKEN / CRON_SECRET only, 401ing otherwise before any FMV
// recalc. Beyond the guard we drive BOTH 2xx accept branches:
//   - feed live  → after()-deferred FMV compute, 202 {accepted:true,note:"fmv_algo_pending"}
//   - feed inert → logged-skip, 202 {accepted:false,skipped:"feed_inert"}
// after() is stubbed no-op so the accept is observable without the deferred
// work; the feed + normalize libs are mocked inert so no live Panini I/O runs.

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: () => {} }
})
const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async () => ({ data: null, error: null })
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { sb }
})
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: sb, supabase: sb }))
vi.mock("@/lib/chains/panini/feed", () => ({
  paniniFeedEnabled: vi.fn(() => true),
  paniniFeedMode: () => "cryptoslam",
}))
vi.mock("@/lib/chains/panini/normalize", () => ({ PANINI_SLUG: "panini_blockchain" }))

import { POST } from "@/app/api/cron/panini-fmv-recalc/route"
import { paniniFeedEnabled } from "@/lib/chains/panini/feed"

// Keep the original inline req builder for the existing guard tests.
const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/panini-fmv-recalc"),
  }) as any

const url = "https://t/api/cron/panini-fmv-recalc"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  process.env.CRON_SECRET = "test-cron-secret"
  ;(paniniFeedEnabled as any).mockReturnValue(true)
})

describe("POST /api/cron/panini-fmv-recalc", () => {
  it("401s with no authorization header", async () => {
    expect((await POST(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await POST(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("POST /api/cron/panini-fmv-recalc — success path (accept, compute deferred)", () => {
  it("202s and reports accepted:true + note fmv_algo_pending when the feed is live", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(true)
    expect(body.collection).toBe("panini_blockchain")
    expect(body.note).toBe("fmv_algo_pending")
    expect(typeof body.started_at).toBe("string")
  })

  it("also accepts CRON_SECRET as the bearer token", async () => {
    const res = await POST(makeReq({ url, auth: "Bearer test-cron-secret" }))
    expect(res.status).toBe(202)
    expect((await res.json()).accepted).toBe(true)
  })

  it("202s with accepted:false + skipped feed_inert when the feed is not enabled", async () => {
    ;(paniniFeedEnabled as any).mockReturnValue(false)
    const res = await POST(makeReq({ url, auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body.accepted).toBe(false)
    expect(body.skipped).toBe("feed_inert")
    expect(body.collection).toBe("panini_blockchain")
  })
})
