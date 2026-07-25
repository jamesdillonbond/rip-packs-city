import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Deep-drive of the owner-only rewards console, /api/admin/rewards.
//
// GET is a five-way rollup plus a decoration pass whose whole job is answering
// "who do I ship this to?" — so the precedence it resolves is the thing worth
// pinning: an explicit fulfillment.gift_to override beats the user's stored
// topshot_username, which beats the Top Shot username derived from their best
// linked wallet. Getting that order wrong sends a real moment to the wrong
// collector. The wallet tiebreak (verified first, then newest verified, then
// newest saved) is pinned for the same reason.
//
// POST is a mutation switch over 8 actions, every one of them credit- or
// delivery-affecting. Each arm is driven through its guard 400, its failure
// status, and its success — notably cancel_refund, which must refuse to refund
// anything that isn't still `pending` (a second refund on an already-refunded
// row would mint credits), and fulfill/draw_raffle, whose SECDEF RPCs signal
// business failure as `{ok:false}` on a 200 rather than as an error.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  adjust: null as unknown,
  adjustThrows: false,
}))

vi.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return state.sb
  },
}))
vi.mock("@/lib/rewards", () => ({
  adminAdjust: async (...args: unknown[]) => {
    if (state.adjustThrows) throw new Error("rewards ledger offline")
    ;(state as { adjustArgs?: unknown[] }).adjustArgs = args
    return state.adjust
  },
}))

process.env.RPC_ADMIN_TOKEN = "rewards-admin-token"

const { GET, POST } = await import("@/app/api/admin/rewards/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

const authed = () =>
  new NextRequest("https://t/api/admin/rewards", {
    headers: new Headers({ authorization: "Bearer rewards-admin-token" }),
  })

function post(body: unknown, opts: { badJson?: boolean; anon?: boolean } = {}) {
  return {
    headers: new Headers(opts.anon ? {} : { authorization: "Bearer rewards-admin-token" }),
    json: async () => {
      if (opts.badJson) throw new Error("not json")
      return body
    },
  } as unknown as NextRequest
}

beforeEach(() => {
  state.adjust = { ok: true, balance: 10 }
  state.adjustThrows = false
})

// GET fires five reads in source order, then (when there are pending rows) four
// more, then wallet_usernames, then raffle_entries. Sequenced fixtures line up
// with that order; v_rewards_user_balances and shop_items are each read twice.
function getFixtures(over: Partial<Record<string, unknown>> = {}): Fixtures {
  return {
    v_rewards_economy: { data: { credits_outstanding: 500 }, error: null },
    v_rewards_user_balances: [
      { data: [{ user_id: "u1", username: "trevor", last_activity: "2026-07-01" }], error: null },
      { data: [{ user_id: "u1", username: "trevor" }], error: null },
    ],
    redemptions: {
      data: [
        {
          id: 1,
          user_id: "u1",
          shop_item_id: 5,
          cost_credits: 100,
          status: "pending",
          requested_at: "2026-07-02",
          fulfillment: { ship_to: "1 Main St" },
        },
      ],
      error: null,
    },
    shop_items: [
      { data: [{ id: 9, sku: "raffle-1", name: "Raffle", active: false, metadata: {} }], error: null },
      { data: [{ id: 5, name: "Blazers Moment", type: "moment" }], error: null },
    ],
    raffle_draws: { data: [], error: null },
    user_profiles: { data: [{ id: "u1", topshot_username: "profile_ts" }], error: null },
    saved_wallets: { data: [{ user_id: "u1", wallet_addr: "0xAB", verified_at: null, id: 2 }], error: null },
    wallet_usernames: { data: [{ wallet_addr: "0xab", username: "wallet_ts" }], error: null },
    raffle_entries: { data: [{ shop_item_id: 9 }, { shop_item_id: 9 }], error: null },
    ...over,
  } as Fixtures
}

describe("GET /api/admin/rewards", () => {
  it("401s without the admin bearer", async () => {
    install({})
    const anon = new NextRequest("https://t/api/admin/rewards")
    expect((await GET(anon)).status).toBe(401)
  })

  it("decorates pending redemptions and counts raffle entries", async () => {
    install(getFixtures())
    const body = await (await GET(authed())).json()

    expect(body.economy).toEqual({ credits_outstanding: 500 })
    expect(body.pending[0]).toMatchObject({
      item_name: "Blazers Moment",
      item_type: "moment",
      username: "trevor",
      ship_to: "1 Main St",
    })
    // profile topshot_username outranks the wallet-derived one.
    expect(body.pending[0].ts_username).toBe("profile_ts")
    expect(body.raffles[0].entry_count).toBe(2)
  })

  it("prefers an explicit gift_to override over every derived username", async () => {
    install(
      getFixtures({
        redemptions: {
          data: [
            {
              id: 1, user_id: "u1", shop_item_id: 5, cost_credits: 100, status: "pending",
              requested_at: "t", fulfillment: { gift_to: "override_ts" },
            },
          ],
          error: null,
        },
      }),
    )
    const body = await (await GET(authed())).json()
    expect(body.pending[0].ts_username).toBe("override_ts")
    expect(body.pending[0].ship_to).toBeNull()
  })

  it("falls back to the best linked wallet's username, preferring a verified wallet", async () => {
    install(
      getFixtures({
        user_profiles: { data: [{ id: "u1", topshot_username: null }], error: null },
        saved_wallets: {
          data: [
            { user_id: "u1", wallet_addr: "0xNEWEST", verified_at: null, id: 9 },
            { user_id: "u1", wallet_addr: "0xVERIFIED", verified_at: "2026-01-01", id: 1 },
          ],
          error: null,
        },
        wallet_usernames: {
          data: [
            { wallet_addr: "0xnewest", username: "newest_ts" },
            { wallet_addr: "0xverified", username: "verified_ts" },
          ],
          error: null,
        },
      }),
    )
    const body = await (await GET(authed())).json()
    expect(body.pending[0].ts_username).toBe("verified_ts")
  })

  it("names an unknown item by id and tolerates a non-object fulfillment", async () => {
    install(
      getFixtures({
        shop_items: [
          { data: [], error: null },
          { data: [], error: null }, // no item row for id 5
        ],
        user_profiles: { data: [], error: null },
        saved_wallets: { data: [], error: null },
        redemptions: {
          data: [
            {
              id: 1, user_id: "u1", shop_item_id: 5, cost_credits: 100, status: "pending",
              requested_at: "t", fulfillment: "not-an-object",
            },
          ],
          error: null,
        },
      }),
    )
    const body = await (await GET(authed())).json()
    expect(body.pending[0]).toMatchObject({ item_name: "Item #5", item_type: null, ts_username: null, ship_to: null })
    expect(body.raffles).toEqual([]) // shop_items empty -> no raffle decoration
  })

  it("returns empty collections rather than nulls when every view is empty", async () => {
    install({
      v_rewards_economy: { data: null, error: null },
      v_rewards_user_balances: { data: null, error: null },
      redemptions: { data: null, error: null },
      shop_items: { data: null, error: null },
      raffle_draws: { data: null, error: null },
    })
    const body = await (await GET(authed())).json()
    expect(body).toEqual({ economy: null, balances: [], pending: [], raffles: [], draws: [] })
  })
})

describe("POST /api/admin/rewards — guards", () => {
  it("401s without the bearer and 400s on an unparseable body", async () => {
    install({})
    expect((await POST(post({ action: "adjust" }, { anon: true }))).status).toBe(401)
    expect((await POST(post(null, { badJson: true }))).status).toBe(400)
  })

  it("400s on an unknown action", async () => {
    install({})
    const res = await POST(post({ action: "nope" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown action: nope")
  })

  it("500s with the message when an arm throws", async () => {
    install({})
    state.adjustThrows = true
    const res = await POST(post({ action: "adjust", userId: "u1", delta: 5, reason: "comp" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("rewards ledger offline")
  })
})

describe("POST /api/admin/rewards — RPC-backed arms", () => {
  for (const [action, idKey, rpc] of [
    ["fulfill", "redemptionId", "fulfill_redemption"],
    ["draw_raffle", "shopItemId", "draw_raffle"],
  ] as const) {
    it(`${action}: 400s on a non-integer id`, async () => {
      install({})
      expect((await POST(post({ action, [idKey]: "abc" }))).status).toBe(400)
    })

    it(`${action}: 500s on an RPC error but 400s on a business {ok:false}`, async () => {
      install({ [`rpc:${rpc}`]: { data: null, error: { message: "rpc down" } } })
      expect((await POST(post({ action, [idKey]: 1 }))).status).toBe(500)

      install({ [`rpc:${rpc}`]: { data: { ok: false, error: "already fulfilled" }, error: null } })
      const res = await POST(post({ action, [idKey]: 1 }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe("already fulfilled")
    })

    it(`${action}: returns the RPC result on success`, async () => {
      const spy = install({ [`rpc:${rpc}`]: { data: { ok: true, id: 1 }, error: null } })
      const res = await POST(post({ action, [idKey]: 1, tx: "0xtx", note: "shipped" }))
      expect(res.status).toBe(200)
      expect((await res.json()).result).toEqual({ ok: true, id: 1 })
      expect(spy.rpcCalls.find((c) => c.name === rpc)?.args).toMatchObject({ p_admin: "owner" })
    })
  }
})

describe("POST /api/admin/rewards — cancel_refund", () => {
  const body = { action: "cancel_refund", redemptionId: 7 }

  it("400s on a non-integer id and 500s when the row read fails", async () => {
    install({})
    expect((await POST(post({ action: "cancel_refund", redemptionId: "x" }))).status).toBe(400)

    install({ redemptions: { data: null, error: { message: "read down" } } })
    expect((await POST(post(body))).status).toBe(500)
  })

  it("404s on a missing row and 400s on one that is no longer pending", async () => {
    install({ redemptions: { data: null, error: null } })
    expect((await POST(post(body))).status).toBe(404)

    install({ redemptions: { data: { id: 7, user_id: "u1", cost_credits: 50, status: "refunded" }, error: null } })
    const res = await POST(post(body))
    expect(res.status).toBe(400)
    // Refusing a second refund is the whole point — it would mint credits.
    expect((await res.json()).error).toContain("cannot refund a refunded redemption")
  })

  it("500s when the credit refund itself fails, leaving the row pending", async () => {
    const spy = install({
      redemptions: { data: { id: 7, user_id: "u1", cost_credits: 50, status: "pending" }, error: null },
    })
    state.adjust = { ok: false, error: "ledger locked" }
    const res = await POST(post(body))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("ledger locked")
    expect(spy.writes.redemptions ?? []).toHaveLength(0) // never marked refunded
  })

  it("refunds the exact cost then marks the row refunded, and 500s if that write fails", async () => {
    const spy = install({
      redemptions: [
        { data: { id: 7, user_id: "u1", cost_credits: 50, status: "pending" }, error: null },
        { data: null, error: null },
      ],
    })
    expect((await POST(post(body))).status).toBe(200)
    expect((state as { adjustArgs?: unknown[] }).adjustArgs).toEqual(["u1", 50, 0, "refund:redemption:7"])
    expect((spy.writes.redemptions ?? []).flatMap((w) => w.rows)[0]).toMatchObject({ status: "refunded" })

    install({
      redemptions: [
        { data: { id: 7, user_id: "u1", cost_credits: 50, status: "pending" }, error: null },
        { data: null, error: { message: "update down" } },
      ],
    })
    expect((await POST(post(body))).status).toBe(500)
  })
})

describe("POST /api/admin/rewards — adjust", () => {
  it("rejects a missing userId, non-integer deltas, and a blank reason", async () => {
    install({})
    expect((await POST(post({ action: "adjust", delta: 1, reason: "x" }))).status).toBe(400)
    expect((await POST(post({ action: "adjust", userId: "u1", delta: 1.5, reason: "x" }))).status).toBe(400)
    expect((await POST(post({ action: "adjust", userId: "u1", delta: 1, statusDelta: 0.5, reason: "x" }))).status).toBe(400)
    expect((await POST(post({ action: "adjust", userId: "u1", delta: 1, reason: "   " }))).status).toBe(400)
  })

  it("500s when the ledger refuses and 200s with the new balance on success", async () => {
    install({})
    state.adjust = { ok: false, error: "cap exceeded" }
    expect((await POST(post({ action: "adjust", userId: "u1", delta: 5, reason: "comp" }))).status).toBe(500)

    state.adjust = { ok: true, balance: 42 }
    const res = await POST(post({ action: "adjust", userId: "u1", delta: 5, statusDelta: 2, reason: "comp" }))
    expect(res.status).toBe(200)
    expect((await res.json()).result).toEqual({ ok: true, balance: 42 })
    expect((state as { adjustArgs?: unknown[] }).adjustArgs).toEqual(["u1", 5, 2, "comp"])
  })
})

describe("POST /api/admin/rewards — catalog toggles + upserts", () => {
  const arms = [
    { action: "toggle_item", table: "shop_items", bad: { itemId: "x", active: true }, good: { itemId: 3, active: false } },
    { action: "toggle_rule", table: "points_rules", bad: { actionKey: "", active: true }, good: { actionKey: "daily_login", active: true } },
    { action: "upsert_item", table: "shop_items", bad: { item: "nope" }, good: { item: { sku: "tee", name: "Tee" } } },
    { action: "upsert_rule", table: "points_rules", bad: { rule: { name: "no key" } }, good: { rule: { action_key: "k", points: 5 } } },
  ] as const

  for (const arm of arms) {
    it(`${arm.action}: 400s on a bad payload, 500s on a write error, 200s on success`, async () => {
      install({})
      expect((await POST(post({ action: arm.action, ...arm.bad }))).status).toBe(400)

      install({ [arm.table]: { data: null, error: { message: "write down" } } })
      expect((await POST(post({ action: arm.action, ...arm.good }))).status).toBe(500)

      const spy = install({ [arm.table]: { data: null, error: null } })
      expect((await POST(post({ action: arm.action, ...arm.good }))).status).toBe(200)
      // Every write stamps updated_at — the console's rows are audited by it.
      expect((spy.writes[arm.table] ?? []).flatMap((w) => w.rows)[0]).toHaveProperty("updated_at")
    })
  }
})
