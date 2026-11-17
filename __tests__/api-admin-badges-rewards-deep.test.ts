import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"
import { adminReq } from "./helpers/admin-req"

// Deep-loop tests for:
//
//   /api/admin/backfill-badges-from-sets — the badge coverage-gap self-heal
//     (INGEST or CRON bearer; the Vercel cron GET re-runs it ADDITIVELY after
//     each badge-sync sweep rewrite — the 2026-07-16 incident contract). Pins:
//     the missing-only additive selection, the badge_score computation, the
//     INTERACTIVE/invisible tag filtering, the fresh-UUID row id (the set-149
//     PK-collision fix), dryRun, and the unreachable-set accounting.
//
//   /api/admin/rewards — owner console (INGEST or RPC_ADMIN bearer). Pins the
//     GET fulfillment-target resolution precedence (gift_to override → profile
//     topshot_username → verified-preferred linked-wallet username), raffle
//     entry counting, and the POST action contracts (fulfill via SECDEF RPC,
//     cancel_refund's refund-then-mark flow, adjust validation).

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gqlCalls: [] as Array<{ query: string; variables: Record<string, unknown> }>,
  gqlHandler: null as null | ((variables: Record<string, unknown>) => unknown),
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (query: string, variables: Record<string, unknown>) => {
    state.gqlCalls.push({ query, variables })
    if (!state.gqlHandler) throw new Error("no gql handler installed")
    return state.gqlHandler(variables)
  },
}))

const badges = await import("@/app/api/admin/backfill-badges-from-sets/route")
const rewards = await import("@/app/api/admin/rewards/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  process.env.CRON_SECRET = "cron-secret"
  process.env.RPC_ADMIN_TOKEN = "admin-token"
  state.gqlCalls.length = 0
  state.gqlHandler = null
  install({})
})

// ── backfill-badges-from-sets ────────────────────────────────────────────────

const SET_UUID = "165e0000-aaaa-4bbb-8ccc-000000000165"
const BADGE_IDS = {
  ROOKIE_YEAR: "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE: "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT: "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_MINT: "24d515af-e967-45f5-a30e-11fc96dc2b62",
  INTERACTIVE: "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
}

// The KD-class trophy edition the sweep structurally misses: three-star rookie
// tags + Rookie Mint → badge_score 1+1+1+1+4 = 8.
const KD_GQL_EDITION = {
  id: "gql-edition-uuid-1",
  tier: "MOMENT_TIER_LEGENDARY",
  parallelID: null,
  parallelName: null,
  set: { id: SET_UUID, flowId: 165, flowName: "MVP Moments", flowSeriesNumber: 5 },
  play: {
    id: "play-uuid-1",
    flowID: "6563",
    stats: {
      playerName: "Kevin Durant",
      teamAtMoment: "Phoenix Suns",
      teamAtMomentNbaId: "1610612756",
      nbaSeason: "2025-26",
      playerID: "201142",
    },
    tags: [
      { id: BADGE_IDS.ROOKIE_YEAR, title: "Rookie Year", visible: true },
      { id: BADGE_IDS.ROOKIE_PREMIERE, title: "Rookie Premiere", visible: true },
      { id: BADGE_IDS.TOP_SHOT_DEBUT, title: "Top Shot Debut", visible: true },
      { id: BADGE_IDS.INTERACTIVE, title: "Interactive", visible: true }, // filtered
      { id: "hidden-tag", title: "Hidden", visible: false }, // filtered
    ],
  },
  setPlay: {
    ID: "sp-1",
    flowRetired: true,
    tags: [{ id: BADGE_IDS.ROOKIE_MINT, title: "Rookie Mint", visible: true }],
    circulations: {
      burned: 10, circulationCount: 100, forSaleByCollectors: 5,
      hiddenInPacks: 2, ownedByCollectors: 80, locked: 20, effectiveSupply: 90,
    },
  },
  circulationCount: 100,
}
// Already covered by badge_editions → must NOT be re-written (additive rule).
const COVERED_GQL_EDITION = {
  ...KD_GQL_EDITION,
  id: "gql-edition-uuid-2",
  play: { ...KD_GQL_EDITION.play, id: "play-uuid-2", flowID: "6564", tags: [] },
}

// Fixture set for the standard scenario:
//   editions: 165:6563 + 165:6564 (set 165, reachable) + 200:1 (set 200, no UUID)
//   badge_editions already has 165:6564 → missing = {165:6563, 200:1}
function badgeFixtures(overrides: Fixtures = {}): Fixtures {
  return {
    editions: {
      data: [
        { external_id: "165:6563", set_id_onchain: 165 },
        { external_id: "165:6564", set_id_onchain: 165 },
        { external_id: "200:1", set_id_onchain: 200 },
        { external_id: "uuid-a:uuid-b", set_id_onchain: 300 }, // non-int-pair — ignored
      ],
      error: null,
    },
    badge_editions: [
      { data: [{ external_id: "165:6564" }], error: null }, // haveBadge read
      { data: [], error: null }, // sibling set-uuid recovery read
      { data: null, error: null }, // upsert result
    ],
    sets: { data: [{ external_id: SET_UUID, set_id_onchain: 165 }], error: null },
    pipeline_runs: { data: null, error: null },
    ...overrides,
  }
}

describe("/api/admin/backfill-badges-from-sets", () => {
  it("401s on a wrong bearer; accepts CRON_SECRET on GET (the post-sweep self-heal cron contract)", async () => {
    expect(
      (await badges.POST(adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer nope" }))).status,
    ).toBe(401)
    // RPC_ADMIN_TOKEN is NOT in this route's token families.
    expect(
      (await badges.POST(adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer admin-token" }))).status,
    ).toBe(401)

    install({ editions: { data: [], error: null }, badge_editions: { data: [], error: null }, sets: { data: [], error: null }, pipeline_runs: { data: null, error: null } })
    const res = await badges.GET(
      adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer cron-secret" }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, totalMissing: 0, upserted: 0 })
  })

  it("writes ONLY the missing editions, with computed badge_score, filtered tags, and a fresh UUID row id", async () => {
    const spy = install(badgeFixtures())
    state.gqlHandler = () => ({
      searchEditions: { searchSummary: { data: { data: [KD_GQL_EDITION, COVERED_GQL_EDITION] } } },
    })

    const res = await badges.POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer ingest-secret" }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      dryRun: false,
      totalMissing: 2,
      reachableSets: 1,
      unreachableNoSetUuidSets: 1,
      unreachableNoSetUuidSetIds: ["200"],
      setsQueried: 1,
      nodesFetched: 2,
      computedRows: 1, // only 165:6563 — the covered sibling is never recomputed
      upserted: 1,
      upsertErrors: 0,
      gqlError: null,
    })

    // One GQL call, for the reachable set's UUID only.
    expect(state.gqlCalls).toHaveLength(1)
    expect(
      (state.gqlCalls[0].variables.input as { filters: { bySetIDs: string[] } }).filters.bySetIDs,
    ).toEqual([SET_UUID])

    const upsert = (spy.writes.badge_editions ?? []).find((w) => w.method === "upsert")!
    expect(upsert.rows).toHaveLength(1)
    const row = upsert.rows[0]
    expect(row).toMatchObject({
      external_id: "165:6563",
      collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
      collection: "nba_top_shot",
      player_name: "Kevin Durant",
      set_name: "MVP Moments",
      series_number: 5,
      tier: "MOMENT_TIER_LEGENDARY",
      parallel_id: 0,
      parallel_name: "Standard",
      is_three_star_rookie: true,
      has_rookie_mint: true,
      badge_score: 8, // RY+RP+TSD+RM + the 4-point three-star-with-mint bonus
      circulation_count: 100,
      effective_supply: 90,
      burned: 10,
      locked: 20,
      owned: 80,
      burn_rate_pct: 10,
      lock_rate_pct: 25,
      flow_retired: true,
    })
    // Tag filtering: INTERACTIVE and invisible tags never land in the row.
    expect((row.play_tags as Array<{ title: string }>).map((t) => t.title)).toEqual([
      "Rookie Year", "Rookie Premiere", "Top Shot Debut",
    ])
    // The set-149 incident fix: row id is a freshly minted UUID, NOT the GQL
    // edition uuid (which parallels/sweep rows can share → PK collision).
    expect(String(row.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(row.id).not.toBe("gql-edition-uuid-1")

    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({
      pipeline: "topshot-badge-set-backfill",
      collection_slug: "nba_top_shot",
      rows_found: 2,
      rows_written: 1,
      ok: true,
      error: null,
    })
    expect(runRow.extra).toMatchObject({
      reachable_sets: 1, unreachable_no_set_uuid_sets: 1, sets_queried: 1, computed_rows: 1,
    })
  })

  it("?dryRun=1 computes rows but writes nothing (no badge_editions upsert, no pipeline_runs row)", async () => {
    const spy = install(badgeFixtures())
    state.gqlHandler = () => ({
      searchEditions: { searchSummary: { data: { data: [KD_GQL_EDITION] } } },
    })

    const res = await badges.POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets?dryRun=1", { authorization: "Bearer ingest-secret" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, dryRun: true, computedRows: 1, upserted: 0 })
    expect((spy.writes.badge_editions ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    expect(spy.writes.pipeline_runs ?? []).toHaveLength(0)
  })

  it("?set=<intId> restricts the walk — an unreachable-only restriction queries nothing", async () => {
    install(badgeFixtures())
    const res = await badges.POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets?set=200", { authorization: "Bearer ingest-secret" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({
      setsQueried: 0,
      unreachableNoSetUuidSetIds: ["200"],
      computedRows: 0,
      upserted: 0,
    })
    expect(state.gqlCalls).toHaveLength(0)
  })

  it("a GQL failure stops the walk and is reported honestly in the response and the run row", async () => {
    const spy = install(badgeFixtures())
    state.gqlHandler = () => {
      throw new Error("Cannot query field parallelName on Edition")
    }

    const res = await badges.POST(
      adminReq("https://t/api/admin/backfill-badges-from-sets", { authorization: "Bearer ingest-secret" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({
      ok: false,
      gqlError: "Cannot query field parallelName on Edition",
      computedRows: 0,
      upserted: 0,
    })
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ ok: false, error: "Cannot query field parallelName on Edition", rows_written: 0 })
  })
})

// ── /api/admin/rewards ───────────────────────────────────────────────────────

function rewardsReq(method: "GET" | "POST", body?: unknown, auth = "Bearer admin-token"): NextRequest {
  const headers = new Headers()
  if (auth) headers.set("authorization", auth)
  const init: RequestInit & { method: string } = { method, headers }
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body)
  return new NextRequest("https://t/api/admin/rewards", init as never)
}

describe("/api/admin/rewards GET", () => {
  it("resolves each pending redemption's fulfillment target: gift_to → profile → verified-preferred wallet username", async () => {
    install({
      v_rewards_economy: { data: { total_spendable: 500 }, error: null },
      v_rewards_user_balances: [
        { data: [{ user_id: "u1", username: "alice" }], error: null }, // balances list
        {
          data: [
            { user_id: "u1", username: "alice" },
            { user_id: "u2", username: "bob" },
            { user_id: "u3", username: "carol" },
          ],
          error: null,
        }, // decoration .in() read
      ],
      redemptions: {
        data: [
          { id: 1, user_id: "u1", shop_item_id: 10, cost_credits: 100, status: "pending", requested_at: "2026-07-01", fulfillment: { gift_to: "GiftTarget" } },
          { id: 2, user_id: "u2", shop_item_id: 10, cost_credits: 100, status: "pending", requested_at: "2026-07-02", fulfillment: {} },
          { id: 3, user_id: "u3", shop_item_id: 99, cost_credits: 50, status: "pending", requested_at: "2026-07-03", fulfillment: { ship_to: "1 Main St" } },
        ],
        error: null,
      },
      shop_items: [
        { data: [{ id: 50, sku: "raffle-1", name: "Team Captain Raffle", active: false, metadata: {} }], error: null }, // raffle list
        { data: [{ id: 10, name: "Gift Moment", type: "moment" }], error: null }, // item decoration
      ],
      raffle_draws: { data: [], error: null },
      user_profiles: {
        data: [
          { id: "u2", topshot_username: "ProfileTS" },
          { id: "u3", topshot_username: null },
        ],
        error: null,
      },
      saved_wallets: {
        data: [
          // u3 has two wallets: the VERIFIED one must win over the newer unverified.
          { user_id: "u3", wallet_addr: "0xAAAA111122223333", verified_at: "2026-01-01T00:00:00Z", id: 1 },
          { user_id: "u3", wallet_addr: "0xbbbb444455556666", verified_at: null, id: 9 },
        ],
        error: null,
      },
      wallet_usernames: {
        data: [
          { wallet_addr: "0xaaaa111122223333", username: "TSUserVerified" },
          { wallet_addr: "0xbbbb444455556666", username: "TSUserNewer" },
        ],
        error: null,
      },
      raffle_entries: {
        data: [{ shop_item_id: 50 }, { shop_item_id: 50 }, { shop_item_id: 50 }],
        error: null,
      },
    })

    const res = await rewards.GET(rewardsReq("GET"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.economy).toEqual({ total_spendable: 500 })
    const byId = new Map(body.pending.map((p: { id: number }) => [p.id, p]))
    expect(byId.get(1)).toMatchObject({
      username: "alice",
      item_name: "Gift Moment",
      item_type: "moment",
      ts_username: "GiftTarget", // explicit override wins
    })
    expect(byId.get(2)).toMatchObject({ ts_username: "ProfileTS" }) // profile beats wallet
    expect(byId.get(3)).toMatchObject({
      item_name: "Item #99", // unknown item falls back to the id label
      item_type: null,
      ts_username: "TSUserVerified", // verified wallet beats the newer unverified one
      ship_to: "1 Main St",
    })
    expect(body.raffles).toEqual([
      expect.objectContaining({ id: 50, sku: "raffle-1", entry_count: 3 }),
    ])
  })

  it("401s fail-closed and accepts INGEST as an alternative bearer", async () => {
    expect((await rewards.GET(rewardsReq("GET", undefined, ""))).status).toBe(401)
    expect((await rewards.GET(rewardsReq("GET", undefined, "Bearer cron-secret"))).status).toBe(401)
    install({ v_rewards_economy: { data: null, error: null } })
    expect((await rewards.GET(rewardsReq("GET", undefined, "Bearer ingest-secret"))).status).toBe(200)
  })
})

describe("/api/admin/rewards POST", () => {
  it("fulfill delegates to the SECDEF fulfill_redemption RPC and maps data.ok=false to a 400", async () => {
    const spy = install({
      "rpc:fulfill_redemption": { data: { ok: true, delivered: "pro" }, error: null },
    })
    const res = await rewards.POST(rewardsReq("POST", { action: "fulfill", redemptionId: 7, tx: "0xtx", note: "shipped" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, result: { ok: true, delivered: "pro" } })
    expect(spy.rpcCalls).toEqual([
      { name: "fulfill_redemption", args: { p_redemption_id: 7, p_tx: "0xtx", p_note: "shipped", p_admin: "owner" } },
    ])

    install({ "rpc:fulfill_redemption": { data: { ok: false, error: "already fulfilled" }, error: null } })
    const bad = await rewards.POST(rewardsReq("POST", { action: "fulfill", redemptionId: 7 }))
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe("already fulfilled")

    expect((await rewards.POST(rewardsReq("POST", { action: "fulfill", redemptionId: "x" }))).status).toBe(400)
  })

  it("cancel_refund refunds the credits via admin_adjust_points THEN marks the row refunded", async () => {
    const spy = install({
      redemptions: [
        { data: { id: 5, user_id: "u1", cost_credits: 120, status: "pending" }, error: null },
        { data: null, error: null }, // the status update
      ],
      "rpc:admin_adjust_points": { data: { ok: true, spendable: 320 }, error: null },
    })
    const res = await rewards.POST(rewardsReq("POST", { action: "cancel_refund", redemptionId: 5 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    // The real lib/rewards.adminAdjust ran: positive delta = the refund.
    expect(spy.rpcCalls).toEqual([
      {
        name: "admin_adjust_points",
        args: { p_user_id: "u1", p_delta: 120, p_status_delta: 0, p_reason: "refund:redemption:5", p_admin: "owner" },
      },
    ])
    const upd = (spy.writes.redemptions ?? []).filter((w) => w.method === "update")
    expect(upd).toHaveLength(1)
    expect(upd[0].rows[0]).toMatchObject({ status: "refunded" })
  })

  it("cancel_refund guards: 404 unknown row, 400 non-pending (no refund RPC fired)", async () => {
    const spy1 = install({ redemptions: { data: null, error: null } })
    expect((await rewards.POST(rewardsReq("POST", { action: "cancel_refund", redemptionId: 5 }))).status).toBe(404)
    expect(spy1.rpcCalls).toHaveLength(0)

    const spy2 = install({
      redemptions: { data: { id: 5, user_id: "u1", cost_credits: 120, status: "fulfilled" }, error: null },
    })
    const res = await rewards.POST(rewardsReq("POST", { action: "cancel_refund", redemptionId: 5 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("cannot refund a fulfilled redemption")
    expect(spy2.rpcCalls).toHaveLength(0)
  })

  it("adjust validates its inputs and passes integers + reason through to the RPC", async () => {
    expect((await rewards.POST(rewardsReq("POST", { action: "adjust", userId: "", delta: 1, statusDelta: 0, reason: "x" }))).status).toBe(400)
    expect((await rewards.POST(rewardsReq("POST", { action: "adjust", userId: "u1", delta: 1.5, statusDelta: 0, reason: "x" }))).status).toBe(400)
    expect((await rewards.POST(rewardsReq("POST", { action: "adjust", userId: "u1", delta: 1, statusDelta: 0, reason: "  " }))).status).toBe(400)

    const spy = install({ "rpc:admin_adjust_points": { data: { ok: true }, error: null } })
    const res = await rewards.POST(
      rewardsReq("POST", { action: "adjust", userId: "u1", delta: -50, statusDelta: 10, reason: "correction" }),
    )
    expect(res.status).toBe(200)
    expect(spy.rpcCalls[0]).toEqual({
      name: "admin_adjust_points",
      args: { p_user_id: "u1", p_delta: -50, p_status_delta: 10, p_reason: "correction", p_admin: "owner" },
    })
  })

  it("rejects unknown actions and invalid JSON with 400s", async () => {
    expect((await rewards.POST(rewardsReq("POST", { action: "detonate" }))).status).toBe(400)
    expect((await rewards.POST(rewardsReq("POST", "{not json"))).status).toBe(400)
  })
})
