import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/pinnacle-sync.
// Fail-closed auth (read at REQUEST time): the GET handler requires Bearer
// INGEST_SECRET_TOKEN exactly and 401s otherwise before rebuilding the per-render
// Pinnacle FMV home. The data seam is `createClient` from @supabase/supabase-js
// (called at module top), stubbed so `pinnacle_fmv_recalc_render_all` returns a
// fixture — the route then logs and returns 200 {status:"ok",fmv_recalc_render}.
// Token is request-time, so the top-level import + env-in-beforeEach regime works.

const { sb } = vi.hoisted(() => {
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async (fn: string) => {
    if (fn === "pinnacle_fmv_recalc_render_all") return { data: { renders_priced: 42 }, error: null }
    return { data: null, error: null }
  }
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { sb }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))

import { GET } from "@/app/api/cron/pinnacle-sync/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-sync"),
  }) as any

const url = "https://t/api/cron/pinnacle-sync"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
})

describe("GET /api/cron/pinnacle-sync", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/pinnacle-sync — success path (render-FMV refresh)", () => {
  it("200s with status:'ok' and the render-recalc payload when authed", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ok")
    expect(body.fmv_recalc_render.renders_priced).toBe(42)
    expect(body.errors).toEqual([])
  })
})
