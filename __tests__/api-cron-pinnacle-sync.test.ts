import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeReq } from "./cron-req-helper"

// Route integration test for GET /api/cron/pinnacle-sync.
// Fail-closed auth (read at REQUEST time): the GET handler requires Bearer
// INGEST_SECRET_TOKEN exactly and 401s otherwise before rebuilding the per-render
// Pinnacle FMV home. The data seam is `createClient` from @supabase/supabase-js
// (called at module top), stubbed so `pinnacle_fmv_recalc_render_all` returns a
// fixture — the route then logs and returns 200 {status:"ok",fmv_recalc_render}.
// Token is request-time, so the top-level import + env-in-beforeEach regime works.

const { sb, afterCbs } = vi.hoisted(() => {
  const afterCbs: Array<() => unknown> = []
  const sb: any = {}
  for (const m of ["from", "select", "eq", "in", "order", "limit", "gte", "lte", "lt", "gt", "is", "not", "or", "neq", "ilike", "match", "range", "insert", "update", "upsert", "delete", "returns"]) sb[m] = () => sb
  sb.single = async () => ({ data: null, error: null })
  sb.maybeSingle = async () => ({ data: null, error: null })
  sb.rpc = async (fn: string) => {
    if (fn === "pinnacle_fmv_recalc_render_all") return { data: { renders_priced: 42 }, error: null }
    return { data: null, error: null }
  }
  sb.then = (resolve: any) => resolve({ data: [], error: null })
  return { sb, afterCbs }
})
vi.mock("@supabase/supabase-js", () => ({ createClient: () => sb }))
// The 2026-07-18 CRON-30S conversion moved the recalc into next/server `after()`,
// which throws "called outside a request scope" under vitest. Capture the callback
// and run it explicitly so the route body stays covered.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void afterCbs.push(cb) }
})

import { GET } from "@/app/api/cron/pinnacle-sync/route"

const req = (auth?: string) =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL("https://t/api/cron/pinnacle-sync"),
  }) as any

const url = "https://t/api/cron/pinnacle-sync"

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "test-ingest-secret"
  afterCbs.length = 0
})

// Drain any work the route deferred to after(), as the real request scope would.
async function drainAfter() {
  const cbs = [...afterCbs]
  afterCbs.length = 0
  for (const cb of cbs) await cb()
}

describe("GET /api/cron/pinnacle-sync", () => {
  it("401s with no authorization header", async () => {
    expect((await GET(req())).status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    expect((await GET(req("Bearer wrong-token"))).status).toBe(401)
  })
})

describe("GET /api/cron/pinnacle-sync — success path (render-FMV refresh)", () => {
  // 2026-07-18 converted this route to the CRON-30S pattern: it returns 202
  // {status:"accepted"} immediately and does the render-FMV recalc inside after(),
  // so cron-job.org stops timing out at 30s. The old contract asserted here was a
  // synchronous 200 {status:"ok", fmv_recalc_render, errors} — that payload is no
  // longer returned to the caller, so we assert the accept envelope and then drain
  // after() to keep the recalc body itself covered.
  it("202s {status:'accepted'} and defers the recalc to after()", async () => {
    const res = await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: "accepted" })
    expect(afterCbs).toHaveLength(1)
  })

  it("runs the render-FMV recalc when the deferred work drains", async () => {
    const rpcCalls: string[] = []
    const origRpc = sb.rpc
    sb.rpc = async (fn: string, args?: unknown) => {
      rpcCalls.push(fn)
      return origRpc(fn, args)
    }
    try {
      await GET(makeReq({ url, method: "GET", auth: "Bearer test-ingest-secret" }))
      await drainAfter()
    } finally {
      sb.rpc = origRpc
    }
    expect(rpcCalls).toContain("pinnacle_fmv_recalc_render_all")
    expect(afterCbs).toHaveLength(0)
  })
})
