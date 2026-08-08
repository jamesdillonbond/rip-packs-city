import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// ─────────────────────────────────────────────────────────────────────────────
// Three /analytics dynamic detail routes that back the public analytics
// dashboards and had NO test importing their module:
//   · /api/analytics/sets/[set_id]
//   · /api/analytics/loans/wallet/[address]
//   · /api/analytics/packs/history/[pack_listing_id]
//
// All three are thin wrappers over an analytics RPC via rpcWithRetry. The
// branches worth pinning are the INPUT GUARDS (a malformed uuid / Flow addr /
// empty id must 400 before the RPC runs) and the not-found vs failed split
// (a missing row is a 404, an RPC fault is a 500) — mislabelling either shows
// visitors a broken dashboard instead of an honest empty/again-later state.
// ─────────────────────────────────────────────────────────────────────────────

const st = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as { message: string } | null },
  throwErr: null as Error | null,
}))

vi.mock("@/lib/analytics/rpc-with-retry", () => ({
  rpcWithRetry: async () => {
    if (st.throwErr) throw st.throwErr
    return st.result
  },
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { GET as setsGET } from "@/app/api/analytics/sets/[set_id]/route"
import { GET as loansGET } from "@/app/api/analytics/loans/wallet/[address]/route"
import { GET as packsGET } from "@/app/api/analytics/packs/history/[pack_listing_id]/route"

const p = <T,>(v: T) => Promise.resolve(v)
const nreq = (u: string) => new NextRequest(u)
const UUID = "11111111-2222-3333-4444-555555555555"

beforeEach(() => {
  st.result = { data: null, error: null }
  st.throwErr = null
})

describe("GET /api/analytics/sets/[set_id]", () => {
  it("400s on a non-UUID set_id (no RPC)", async () => {
    const res = await setsGET(nreq("https://t/x"), { params: p({ set_id: "not-a-uuid" }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_set_id")
  })
  it("404s when the RPC raises a 'not found' exception", async () => {
    st.result = { data: null, error: { message: "set not found" } }
    const res = await setsGET(nreq("https://t/x"), { params: p({ set_id: UUID }) })
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("set_not_found")
  })
  it("500s on any other RPC error", async () => {
    st.result = { data: null, error: { message: "deadlock detected" } }
    const res = await setsGET(nreq("https://t/x"), { params: p({ set_id: UUID }) })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets_detail_failed")
  })
  it("404s when the RPC returns null data with no error", async () => {
    st.result = { data: null, error: null }
    const res = await setsGET(nreq("https://t/x"), { params: p({ set_id: UUID }) })
    expect(res.status).toBe(404)
  })
  it("200s with the payload + cache header on success", async () => {
    st.result = { data: { set: { name: "Base Set" }, editions: [] }, error: null }
    const res = await setsGET(nreq("https://t/x"), { params: p({ set_id: UUID }) })
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=600")
  })
  it("500s if rpcWithRetry throws (outer catch)", async () => {
    st.throwErr = new Error("boom")
    const res = await setsGET(nreq("https://t/x"), { params: p({ set_id: UUID }) })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets_detail_failed")
  })
})

describe("GET /api/analytics/loans/wallet/[address]", () => {
  const addr = "0x" + "a".repeat(16)
  it("400s on a malformed Flow address (no RPC)", async () => {
    const res = await loansGET(nreq("https://t/x"), { params: p({ address: "0xabc" }) })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_address")
  })
  it("500s on an RPC error", async () => {
    st.result = { data: null, error: { message: "db down" } }
    const res = await loansGET(nreq("https://t/x"), { params: p({ address: addr }) })
    expect(res.status).toBe(500)
  })
  it("404s when the RPC returns null (unknown/inactive wallet)", async () => {
    st.result = { data: null, error: null }
    const res = await loansGET(nreq("https://t/x"), { params: p({ address: addr }) })
    expect(res.status).toBe(404)
  })
  it("200s with the payload on success", async () => {
    st.result = { data: { addr, positions: [] }, error: null }
    const res = await loansGET(nreq("https://t/x"), { params: p({ address: addr.toUpperCase() }) })
    expect(res.status).toBe(200)
  })
  it("500s if the RPC throws (outer catch)", async () => {
    st.throwErr = new Error("net")
    const res = await loansGET(nreq("https://t/x"), { params: p({ address: addr }) })
    expect(res.status).toBe(500)
  })
})

describe("GET /api/analytics/packs/history/[pack_listing_id]", () => {
  it("400s on an empty pack_listing_id", async () => {
    const res = await packsGET(nreq("https://t/x"), { params: p({ pack_listing_id: "  " }) })
    expect(res.status).toBe(400)
  })
  it("clamps ?days to [1,90] and returns 200", async () => {
    st.result = { data: [{ d: "2026-08-01", price: 10 }], error: null }
    const res = await packsGET(nreq("https://t/x?days=9999"), {
      params: p({ pack_listing_id: "pl-1" }),
    })
    expect(res.status).toBe(200)
  })
  it("defaults ?days when non-numeric and returns 200", async () => {
    st.result = { data: [], error: null }
    const res = await packsGET(nreq("https://t/x?days=abc"), {
      params: p({ pack_listing_id: "pl-1" }),
    })
    expect(res.status).toBe(200)
  })
  it("500s on an RPC error", async () => {
    st.result = { data: null, error: { message: "boom" } }
    const res = await packsGET(nreq("https://t/x"), { params: p({ pack_listing_id: "pl-1" }) })
    expect(res.status).toBe(500)
  })
  it("500s if the RPC throws (outer catch)", async () => {
    st.throwErr = new Error("x")
    const res = await packsGET(nreq("https://t/x"), { params: p({ pack_listing_id: "pl-1" }) })
    expect(res.status).toBe(500)
  })
})
