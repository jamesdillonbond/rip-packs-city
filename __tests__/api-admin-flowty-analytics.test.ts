import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/flowty-analytics (GET).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR Bearer RPC_ADMIN_TOKEN,
// fail-closed. Happy path with empty MVs/RPCs returns a zeroed summary + the
// static dataCaveats. Pins the fail-closed 401 and the empty happy path.

vi.mock("@/lib/supabase", () => {
  const result = { data: [], error: null }
  const make = () => {
    const c: any = {}
    for (const m of ["select", "gte", "lte", "limit", "eq"]) c[m] = () => c
    c.then = (resolve: any) => resolve(result)
    return c
  }
  return { supabaseAdmin: { from: () => make(), rpc: async () => result } }
})

import { GET } from "@/app/api/admin/flowty-analytics/route"

const ADMIN = "test-admin-token"

function req(auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest("https://t/api/admin/flowty-analytics?collection=topshot&period=monthly", { headers })
}

beforeEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})
afterEach(() => {
  delete process.env.RPC_ADMIN_TOKEN
  delete process.env.INGEST_SECRET_TOKEN
})

describe("GET /api/admin/flowty-analytics", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await GET(req(`Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("returns a zeroed payload for empty MVs when authed", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await GET(req(`Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.collection).toBe("topshot")
    expect(body.summary.salesAllTimeVolumeUsd).toBe(0)
    expect(body.salesTimeseries).toEqual([])
    expect(Array.isArray(body.dataCaveats)).toBe(true)
  })
})
