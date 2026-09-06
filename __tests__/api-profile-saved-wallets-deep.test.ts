import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import { publishedCollections } from "@/lib/collections"

// Deep test for /api/profile/saved-wallets — drives the owner-scoped write body
// + the allow-list self-heal that the shallow test (401s + param 400s + one
// happy GET) leaves uncovered. Assertions target handler-COMPUTED writes: the
// auto-attach row-per-published-collection with the session user_id, the Pro
// saved-wallet cap 402, the lowercased/defaulted upsert payload, the PATCH
// skipped-vs-updated branch, and the 2026-08-08 deep cross-collection warm
// dispatched on a NEW wallet only (this paste-an-address path previously
// dispatched nothing, so open-door signups — who have no allow_list row for the
// self-heal to find — got a saved_wallets row and an empty moments cache).

const captured = vi.hoisted(() => ({ fn: null as null | (() => Promise<void>) }))
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (fn: () => Promise<void>) => { captured.fn = fn } }
})

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

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  state.sb = null
  state.user = null
  state.quota = { daily_limit: null, plan: "pro_paid" }
  state.writes = {}
  captured.fn = null
  process.env.INGEST_SECRET_TOKEN = "ingest-tok"
  fetchMock = vi.fn(async () => ({ ok: true, status: 202 }))
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe("GET /api/profile/saved-wallets — allow-list self-heal", () => {
  // 2026-09-06: one row per published FLOW collection. The allow-list address
  // is a Flow 0x… address; Candy MLB (Solana) is published now and must NOT
  // receive a row it can never match ("0 moments" manufactured by us).
  it("auto-attaches one wallet row per published FLOW collection with the session user_id — never the Solana one", async () => {
    state.user = { id: "u1", email: "Me@X.com" }
    const attached = publishedCollections()
      .filter((c) => c.dbChain === "flow")
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

    const published = publishedCollections().filter((c) => c.dbChain === "flow").length
    expect(publishedCollections().length).toBeGreaterThan(published) // the Solana one exists and is excluded
    expect(body.wallets).toHaveLength(published)
    expect(body.wallets[0].cached_fmv).toBeNull()
    expect(body.wallets[0].pinned_at).toBeTruthy()

    const up = state.writes["saved_wallets"]?.find((w) => w.method === "upsert")
    expect(up?.rows).toHaveLength(published)
    expect(up?.rows.every((r) => r.user_id === "u1")).toBe(true)
    expect(up?.rows.every((r) => r.wallet_addr === "0xabc")).toBe(true) // lowercased from allow_list
    expect(up?.rows.every((r) => r.accent_color === "#E03A2F")).toBe(true)
    const candyId = publishedCollections().find((c) => c.id === "candy-mlb")?.supabaseCollectionId
    expect(candyId).toBeTruthy()
    expect(up?.rows.some((r) => r.collection_id === candyId)).toBe(false)
  })

  // ⚠ THIS GUARD PROTECTS A WRITE, AND `?? 0` MADE IT FAIL OPEN INTO ONE.
  //
  // The zero-rows-EVER guard was `if ((totalRows ?? 0) > 0) return []`.
  // supabase-js RESOLVES on a query error, so a failed count is
  // `{ count: null, error }` -> `0 > 0` is false -> the guard reads "this user
  // has no wallets" and falls through to the upsert. A database hiccup could
  // therefore RE-SEED wallets for a user who already has them, resetting
  // `username` and `accent_color` on the conflicting rows and restoring a
  // wallet the user may have deleted deliberately.
  //
  // ⚠ The guard's own comment accepts re-seeding a deliberate deletion as
  // "acceptable at current scale" — but that was reasoned about a GENUINE zero,
  // not about a read that failed. The self-heal is best-effort, so "we could not
  // tell" must mean DO NOTHING.
  //
  // Pinned on the WRITE, not on the response body: the body is `[]` either way,
  // so asserting it would pass against the defect.
  it("does NOT upsert when the zero-rows-EVER count read errors", async () => {
    state.user = { id: "u1", email: "Me@X.com" }
    install({
      saved_wallets: [
        { data: [], error: null }, // main list query -> empty -> trigger self-heal
        { count: null, error: { message: "canceling statement due to statement timeout" } },
      ],
      allow_list: { data: { wallet_addr: "0xABC", username: "u" }, error: null },
    })

    const res = await GET(req("https://t/api/profile/saved-wallets"))
    expect(res.status).toBe(200)
    expect(state.writes["saved_wallets"]?.some((w) => w.method === "upsert")).toBeFalsy()
  })

  it("does NOT upsert when the count is absent without an error", async () => {
    state.user = { id: "u1", email: "Me@X.com" }
    install({
      saved_wallets: [
        { data: [], error: null },
        { data: null, error: null }, // no `count` key at all
      ],
      allow_list: { data: { wallet_addr: "0xABC", username: "u" }, error: null },
    })

    await GET(req("https://t/api/profile/saved-wallets"))
    expect(state.writes["saved_wallets"]?.some((w) => w.method === "upsert")).toBeFalsy()
  })

  it("NO-CHANGE CONTROL: a user who genuinely already has wallets is still left alone", async () => {
    // The other half of the guard. Without this, "never upsert" would satisfy
    // both cases above and the self-heal would be dead rather than careful.
    state.user = { id: "u1", email: "Me@X.com" }
    install({
      saved_wallets: [
        { data: [], error: null }, // no rows for THIS collection filter
        { count: 3, error: null }, // ...but three EVER -> do not re-seed
      ],
      allow_list: { data: { wallet_addr: "0xABC", username: "u" }, error: null },
    })

    await GET(req("https://t/api/profile/saved-wallets"))
    expect(state.writes["saved_wallets"]?.some((w) => w.method === "upsert")).toBeFalsy()
  })
})

describe("POST /api/profile/saved-wallets — cap + write shape", () => {
  // saved_wallets holds ONE ROW PER (wallet, collection), so a single Dapper
  // wallet is 5 rows. The cap is about PHYSICAL wallets — these fixtures use the
  // real 5-row shape so any regression back to counting ROWS reads 5 and fails.
  const oneWalletFiveRows = [
    { wallet_addr: "0x1111111111111111" },
    { wallet_addr: "0x1111111111111111" },
    { wallet_addr: "0x1111111111111111" },
    { wallet_addr: "0x1111111111111111" },
    { wallet_addr: "0x1111111111111111" },
  ]

  it("402s at the plan limit when the user is already at their saved-wallet cap", async () => {
    state.user = { id: "u1" }
    state.quota = { daily_limit: 1, plan: "free" }
    install({
      saved_wallets: [
        { data: oneWalletFiveRows, error: null }, // 5 rows, 1 distinct wallet
      ],
    })

    const res = await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0x2222222222222222" }))
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
        { count: 5, error: null }, // new-wallet probe → already held
        { data: { id: "w1", wallet_addr: "0x1111111111111111" }, error: null }, // upsert().select().single()
      ],
    })

    const res = await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0x1111111111111111" }))
    expect(res.status).toBe(200)
  })

  it("upserts a lowercased address with the session user_id and default NBA collection", async () => {
    state.user = { id: "u1", email: "a@b.com" }
    state.quota = { daily_limit: null, plan: "pro_paid" } // unlimited → skip cap
    install({
      saved_wallets: [
        { data: [], error: null }, // distinct-wallet cap read → nothing saved yet
        { count: 0, error: null }, // new-wallet probe
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

describe("POST /api/profile/saved-wallets — deep cross-collection warm", () => {
  it("dispatches the multicollection backfill for a NEW Flow wallet", async () => {
    state.user = { id: "u1" }
    install({
      saved_wallets: [
        { data: [], error: null },
        { count: 0, error: null }, // never saved before → new
        { data: { id: "w1", wallet_addr: "0xabcdef0123456789" }, error: null },
      ],
    })

    expect((await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0xABCDEF0123456789" }))).status).toBe(200)
    expect(captured.fn).toBeTypeOf("function")
    await captured.fn!()

    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("wallet-backfill-multicollection"))
    expect(call).toBeTruthy()
    expect((call![1] as any).headers.Authorization).toBe("Bearer ingest-tok")
    // skip_cached:false — a wallet whose cache was page-capped by the old
    // shallow warm must be fully re-walked, not skipped.
    expect(JSON.parse((call![1] as any).body)).toEqual({
      wallet: "0xabcdef0123456789",
      skip_cached: false,
    })
  })

  it("does NOT re-warm a wallet the user already has saved", async () => {
    state.user = { id: "u1" }
    install({
      saved_wallets: [
        { data: [{ wallet_addr: "0xabcdef0123456789" }], error: null },
        { count: 3, error: null }, // already held under 3 collections
        { data: { id: "w1", wallet_addr: "0xabcdef0123456789" }, error: null },
      ],
    })

    expect((await POST(req("https://t/api/profile/saved-wallets", { walletAddr: "0xabcdef0123456789" }))).status).toBe(200)
    expect(captured.fn).toBeNull()
  })

  // isValidAddressForChain has lived in lib/address.ts for a while but was wired
  // NOWHERE on this path, so a wallet could be saved under a collection whose
  // chain it can never match — a row that renders as an empty collection.
  it("400s a chain-mismatched address instead of saving a row that can never match", async () => {
    state.user = { id: "u1" }
    install({ saved_wallets: [{ data: [], error: null }] })

    // EVM (0x + 40 hex) — 0x-prefixed but NOT Flow, saved under NBA Top Shot.
    const evm = "0x" + "a".repeat(40)
    const res = await POST(req("https://t/api/profile/saved-wallets", { walletAddr: evm }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("address_chain_mismatch")
    expect(captured.fn).toBeNull() // nothing scheduled, nothing warmed
  })

  it("400s a Flow address saved under Candy (and vice versa)", async () => {
    state.user = { id: "u1" }
    const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"
    install({ saved_wallets: [{ data: [], error: null }] })
    const res = await POST(
      req("https://t/api/profile/saved-wallets", { walletAddr: "0xabcdef0123456789", collectionId: CANDY }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("address_chain_mismatch")
  })

  it("accepts a case-sensitive base58 Candy address under Candy, case INTACT", async () => {
    state.user = { id: "u1" }
    const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"
    const sol = "63p1oKqkAQ9sQD55iApNRkVL2XzYtASwKjCdSSNEGEhY"
    install({
      saved_wallets: [
        { data: [], error: null },
        { count: 0, error: null },
        { data: { id: "w1", wallet_addr: sol }, error: null },
      ],
    })

    const res = await POST(
      req("https://t/api/profile/saved-wallets", { walletAddr: sol, collectionId: CANDY }),
    )
    expect(res.status).toBe(200)
    // THE bug this closes: a bare .toLowerCase() mangles base58 and the row then
    // matches none of the Candy wallet_moments_cache rows.
    const up = state.writes["saved_wallets"]?.find((w) => w.method === "upsert")
    expect(up?.rows[0].wallet_addr).toBe(sol)

    await captured.fn!()
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes("wallet-backfill-candy"))
    expect(call).toBeTruthy() // routed to the Candy enricher, not the Flow orchestrator
    expect(JSON.parse((call![1] as any).body).wallet).toBe(sol)
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
