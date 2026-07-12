import { describe, it, expect, beforeAll, vi } from "vitest"

// Route-integration test for /api/cron/purge-stale-listings.
// Auth: Bearer INGEST_SECRET_TOKEN (guard active only when the token env is set)
// Highest-value assertion: fail-closed auth — no auth and a wrong bearer both 401
// before any DB/upstream work. Tokens are set below so the handler exercises its
// real comparison branch (the route module is imported dynamically afterwards).
// Success path: GET runs SYNCHRONOUSLY — it awaits
// from("cached_listings").delete().lt(...).select("id") and returns 200
// { ok:true, deletedCount: data.length }. The chainable stub resolves to a
// fixture list of deleted ids so deletedCount is fixture-derived.

// Route imports supabaseAdmin from "@/lib/supabase"; stub a self-referential,
// thenable delete-chain that resolves to the deleted-id fixture.
const sbChain: any = {
  from: () => sbChain,
  delete: () => sbChain,
  lt: () => sbChain,
  select: () => sbChain,
  then: (resolve: any) =>
    resolve({ data: [{ id: "a" }, { id: "b" }, { id: "c" }], error: null }),
}
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => sbChain },
}))

process.env.INGEST_SECRET_TOKEN = "test-ingest-token"
process.env.CRON_SECRET = "test-cron-secret"

import { makeReq } from "./cron-req-helper"

let mod: any
beforeAll(async () => {
  mod = await import("@/app/api/cron/purge-stale-listings/route")
})

describe("GET /api/cron/purge-stale-listings", () => {
  it("401s without an authorization header (fail-closed)", async () => {
    const res = await mod.GET(makeReq({ method: "GET" }))
    expect(res.status).toBe(401)
  })

  it("401s with a wrong bearer token", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer wrong-token" }))
    expect(res.status).toBe(401)
  })
})

describe("GET /api/cron/purge-stale-listings — success path (synchronous delete count)", () => {
  it("200s with ok and deletedCount from the deleted-id fixture length", async () => {
    const res = await mod.GET(makeReq({ method: "GET", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.deletedCount).toBe(3)
  })

  it("POST reaches the same 200 accept when authed", async () => {
    const res = await mod.POST(makeReq({ method: "POST", auth: "Bearer test-ingest-token" }))
    expect(res.status).toBe(200)
    expect((await res.json()).deletedCount).toBe(3)
  })
})
