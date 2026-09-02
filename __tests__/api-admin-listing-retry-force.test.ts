import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/admin/listing-retry-force (POST).
// isAuthorized(): Bearer INGEST_SECRET_TOKEN OR RPC_ADMIN_TOKEN, fail-closed.
// Pins the 401, the id-required 400, a 404 when the row is absent, and a 2xx
// success: an already-resolved row short-circuits to {ok:true, already_resolved:
// true} before any Cadence/Flow I/O. The listing_resolution_failures lookup is
// driven via a hoisted mutable holder so each test picks the returned row.

// `seq` drives maybeSingle CALL BY CALL (call 1 = the failures-row fetch, call 2
// = the wmc lookup, and so on) so a single lookup can be failed in isolation;
// when it is empty every call falls back to `row`. `updates` records every
// write, which is how the "a failed read must not touch the row" cases assert an
// ABSENCE rather than an error string.
const state = vi.hoisted(() => ({
  row: { data: null as any, error: null as any },
  seq: [] as Array<{ data: any; error: any }>,
  updates: [] as any[],
  upsertError: null as any,
  writeError: null as any,
}))
vi.mock("@/lib/supabase", () => {
  // The chain is THENABLE so `await from(x).update(y).eq(...)` resolves the way
  // supabase-js does — `{ error }` — which is the only way to drive the
  // write-failure branches. Terminal reads still go through maybeSingle().
  const chain: any = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => (state.seq.length > 0 ? state.seq.shift() : state.row),
    update: (rows: any) => {
      state.updates.push(rows)
      return chain
    },
    upsert: async () => ({ error: state.upsertError }),
    then: (resolve: (v: unknown) => unknown) => resolve({ error: state.writeError }),
  }
  return { supabaseAdmin: { from: () => chain } }
})

import { POST } from "@/app/api/admin/listing-retry-force/route"

const ADMIN = "test-admin-token"

function post(query: string, auth?: string): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  return new NextRequest(`https://t/api/admin/listing-retry-force${query}`, { method: "POST", headers })
}

function reset() {
  delete process.env.RPC_ADMIN_TOKEN
  state.row = { data: null, error: null }
  state.seq.length = 0
  state.updates.length = 0
  state.upsertError = null
  state.writeError = null
}
beforeEach(reset)
afterEach(reset)

const OPEN_ROW = {
  id: 7,
  resolved_at: null,
  collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070",
  flow_id: "555",
  listing_resource_id: "LR-7",
  retry_count: 9,
  event_payload: {
    blockHeight: 1,
    blockTimestamp: "2026-07-01T00:00:00Z",
    txHash: "ab".repeat(32),
    eventIndex: 0,
    listingResourceID: "LR-7",
    storefrontAddress: "0xseller",
    nftID: "555",
    salePrice: "25.00000000",
    salePaymentVaultType: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
    customID: null,
  },
}

describe("POST /api/admin/listing-retry-force", () => {
  it("401s fail-closed when no token env is set", async () => {
    expect((await POST(post("?id=1", `Bearer ${ADMIN}`))).status).toBe(401)
  })

  it("400s when id is missing or non-numeric", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    expect((await POST(post("", `Bearer ${ADMIN}`))).status).toBe(400)
    expect((await POST(post("?id=abc", `Bearer ${ADMIN}`))).status).toBe(400)
  })

  it("404s when the row does not exist", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    const res = await POST(post("?id=99", `Bearer ${ADMIN}`))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("row not found")
  })

  it("200s already_resolved when the row is already resolved (authed, pre-I/O)", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    state.row = { data: { id: 7, resolved_at: "2026-07-01T00:00:00Z" }, error: null }
    const res = await POST(post("?id=7", `Bearer ${ADMIN}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.already_resolved).toBe(true)
    expect(body.resolved_at).toBe("2026-07-01T00:00:00Z")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 🚨 A FAILED READ MUST NOT SPEND THE ROW'S RETRY BUDGET.
// Each lookup used to discard supabase-js's `error` and test only `data?.x`, so
// an unread table looked like an absent mapping and the request fell into the
// `!editionUuid` branch — which BUMPS retry_count. The drainer retires a row
// permanently at 10 bumps, so an operator's force-retry during a database blip
// made the row HARDER to recover, and answered 200.
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /api/admin/listing-retry-force — a failed lookup 500s and touches nothing", () => {
  for (const [nth, name, wants] of [
    [1, "wallet_moments_cache", "wallet_moments_cache lookup"],
    [2, "nft_edition_map", "nft_edition_map lookup"],
  ] as const) {
    it(`500s on a failed ${name} read and leaves retry_count alone`, async () => {
      process.env.RPC_ADMIN_TOKEN = ADMIN
      // Call 1 is the failures-row fetch; the lookups follow in order. Every
      // lookup before the target one must MISS so control reaches it.
      state.seq = [
        { data: OPEN_ROW, error: null },
        ...Array.from({ length: nth - 1 }, () => ({ data: null, error: null })),
        { data: null, error: { message: `${name} down` } },
      ]
      const res = await POST(post("?id=7", `Bearer ${ADMIN}`))
      expect(res.status).toBe(500)
      expect(String((await res.json()).error)).toContain(wants)
      // ⛔ The load-bearing assertion: the row sits at retry_count 9, one bump
      // from permanent retirement, and nothing wrote to it.
      expect(state.updates).toHaveLength(0)
    })
  }

  it("500s on a failed editions read and leaves retry_count alone", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    state.seq = [
      { data: OPEN_ROW, error: null },
      { data: { edition_key: "EXT-555" }, error: null }, // wmc hit -> skip the map + Cadence
      { data: null, error: { message: "editions down" } },
    ]
    const res = await POST(post("?id=7", `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    expect(String((await res.json()).error)).toContain("editions lookup")
    expect(state.updates).toHaveLength(0)
  })

  // ⛔ THE MARK IS THE RESOLUTION. This used to log the error and answer
  // {ok:true, resolved:true} — telling the operator the row was closed while it
  // sat in the queue, which is precisely the signal that stops them looking.
  it("does not answer resolved:true when the resolved-mark UPDATE fails", async () => {
    process.env.RPC_ADMIN_TOKEN = ADMIN
    state.seq = [
      { data: OPEN_ROW, error: null },
      { data: { edition_key: "EXT-555" }, error: null },
      { data: { id: "uuid-555" }, error: null },
    ]
    state.writeError = { message: "mark boom" }

    const res = await POST(post("?id=7", `Bearer ${ADMIN}`))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.resolved).toBe(false)
    expect(String(body.error)).toContain("resolved-mark")
    // The v2 row DID land, and saying so is what makes a retry safe to run.
    expect(body.v2_upserted).toBe(true)
  })
})
