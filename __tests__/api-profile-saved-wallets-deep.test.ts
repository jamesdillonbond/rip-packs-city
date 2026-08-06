import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import { publishedCollections } from "@/lib/collections"

// Deep test for /api/profile/saved-wallets — drives the owner-scoped write body
// + the allow-list self-heal that the shallow test (401s + param 400s + one
// happy GET) leaves uncovered. Assertions target handler-COMPUTED writes: the
// auto-attach row-per-published-collection with the session user_id, the Pro
// saved-wallet cap 402, the lowercased/defaulted upsert payload, and the PATCH
// skipped-vs-updated branch.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  user: null as null | { id: string; email?: string },
  quota: { daily_limit: null as number | null, plan: "pro_paid" },
  writes: {} as Record<string, { method: string; rows: Record<string, unknown>[] }[]>,
}))

vi.mock("@/lib/supabase", () => {
  const client = new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] })
  return { supabaseAdmin: client, supabase: client }
})
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return state.user
  },
}))
vi.mock("@/lib/pro-tier", () => ({ checkFeatureQuota: async () => state.quota }))

import { GET, POST, DELETE, PATCH } from "@/app/api/profile/saved-wallets/route"

const NBA = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

function install(fixtures: Record<string, unknown>) {
  const spy = makeInstrumentedSupabaseFixture(fixtures as never)
  state.sb = spy.fixture
  state.writes = spy.writes
}

const req = (url: string, body?: unknown, throws = false) =>
  ({
    nextUrl: new URL(url),
    json: async () => {
      if (throws) throw new Error("bad json")
      return body
    },
  }) as never

beforeEach(() => {
  state.sb = null
  state.user = null
  state.quota = { daily_limit: null, plan: "pro_paid" }
  state.writes = {}
})

describe("GET /api/profile/saved-wallets — allow-list self-heal", () => {
  it("auto-attaches one wallet row per published collection with the session user_id", async () => {
    state.user = { id: "u1", email: "Me@X.com" }
    const attached = publishedCollections()
      .map((c) => c.supabaseCollectionId)
      .filter(Boolean)
      .map((cid) => ({ id: `w-${cid}`, wallet_addr: "0xabc", collection_id: cid, cached_fmv_usd: null }))
    install({
      saved_wallets: [
        { data: [], error: null }, // main list query → empty → trigger self-heal
        { count: 0, error: null }, // zero-rows-EVER guard
        { data: attached, error: null }, // upsert().select()
      ],
      allow_list: { data: { wallet_addr: "0xABC", username: "u" }, error: null },
    })

    const res = await GET(req("https://t/api/profile/saved-wallets"))
    expect(res.status).toBe(200)
    const body = await res.json()

    const published = publishedCollections().length
    expect(body.wallets).toHaveLength(published)
    expect(body.wallets[0].cached_fmv).toBeNull()
    expect(body.wallets[0].pinned_at).toBeTruthy()

    const up = state.writes["saved_wallets"]?.find((w) => w.method === "upsert")
    expect(up?.rows).toHaveLength(published)
    expect(up?.rows.every((r) => r.user_id === "u1")).toBe(true)
    expect(up?.rows.every((r) => r.wallet_addr === "0xabc")).toBe(true) // lowercased from allow_list
    expect(up?.rows.every((r) => r.accent_color === "#E03A2F")).toBe(true)
  })
})

describe("POST /api/profile/saved-wallets — cap + write shape", () => {
  // saved_wallets holds ONE ROW PER (wallet, collection), so a single Dapper
  // wallet is 5 rows. The cap is about PHYSICAL wallets — these fixtures use the
  // real 5-row shape so any regression back to counting ROWS reads 5 and fails.
  const oneWalletFiveRows = [
    { wallet_addr: "0xexisting" },
    { wallet_addr: "0xexisting" },
    { wallet_addr: "0xexisting" },
    { wallet_addr: "0xexisting" },
    { wallet_addr: "0xexisting" },
  ]

  it("402s at the plan limit when the user is already at their saved-wallet cap", async () => {
    state.user = { id: "u1" }
    state.quota = { daily_limit: 1, plan: "free" }
    install({
      saved_wallets: [
        { data: oneWalletFiveRows, error: null }, // 5 rows, 1 distinct wallet
      ],
    })

    const res = await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0xNEW" }))
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body).toMatchObject({
      error: "plan_limit_reached",
      plan: "free",
      saved_wallet_count: 1, // DISTINCT wallets, not the 5 rows
      saved_wallet_limit: 1,
    })
  })

  // REGRESSION (2026-08-05): counting rows meant a free user (cap 1) was blocked
  // on their own wallet the moment resolve-and-associate wrote its 5 collection
  // rows — currentCount read 5 >= 1 for a wallet they already owned.
  it("does NOT 402 when re-saving a wallet already held across 5 collections at cap 1", async () => {
    state.user = { id: "u1" }
    state.quota = { daily_limit: 1, plan: "free" }
    install({
      saved_wallets: [
        { data: oneWalletFiveRows, error: null },
        { data: { id: "w1", wallet_addr: "0xexisting" }, error: null }, // upsert().select().single()
      ],
    })

    const res = await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0xEXISTING" }))
    expect(res.status).toBe(200)
  })

  it("upserts a lowercased address with the session user_id and default NBA collection", async () => {
    state.user = { id: "u1", email: "a@b.com" }
    state.quota = { daily_limit: null, plan: "pro_paid" } // unlimited → skip cap
    install({
      saved_wallets: [
        { data: [], error: null }, // distinct-wallet cap read → nothing saved yet
        { data: { id: "w1", wallet_addr: "0xabcdef0123456789" }, error: null }, // upsert().select().single()
      ],
    })

    const res = await POST(
      req("https://t/api/profile/saved-wallets", { walletAddr: "0xABCDEF0123456789", nickname: "main" }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).wallet.id).toBe("w1")
    const up = state.writes["saved_wallets"]?.find((w) => w.method === "upsert")
    expect(up?.rows[0]).toMatchObject({
      user_id: "u1",
      wallet_addr: "0xabcdef0123456789",
      collection_id: NBA,
      nickname: "main",
      accent_color: "#E03A2F",
    })
  })
})

describe("PATCH /api/profile/saved-wallets — update vs skipped", () => {
  it("returns skipped when no owned row matches the wallet", async () => {
    state.user = { id: "u1" }
    install({ saved_wallets: { data: [], error: null } })
    const res = await PATCH(req("https://t/api/profile/saved-wallets", { walletAddr: "0xabc", cachedFmv: 5 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, skipped: true })
  })

  it("returns the updated wallet when the owned row matches", async () => {
    state.user = { id: "u1" }
    install({ saved_wallets: { data: [{ id: "w1", cached_fmv_usd: 5 }], error: null } })
    const res = await PATCH(req("https://t/api/profile/saved-wallets", { walletAddr: "0xabc", cachedFmv: 5 }))
    expect(res.status).toBe(200)
    expect((await res.json()).wallet.id).toBe("w1")
  })
})

describe("DELETE /api/profile/saved-wallets", () => {
  it("200s ok on a successful owner-scoped delete", async () => {
    state.user = { id: "u1" }
    install({ saved_wallets: { error: null } })
    const res = await DELETE(req("https://t/api/profile/saved-wallets", { walletAddr: "0xABC" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("500s on a delete DB error", async () => {
    state.user = { id: "u1" }
    install({ saved_wallets: { error: { message: "delete failed" } } })
    const res = await DELETE(req("https://t/api/profile/saved-wallets", { walletAddr: "0xabc" }))
    expect(res.status).toBe(500)
  })
})
