import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
} from "./helpers/route-harness"

// Deep-drive of POST /api/ingest — the GQL native-marketplace sales ingest and
// historical home of the platform-wide mis-attribution bug. Captures after()
// and drives the real body with a scripted searchMarketplaceTransactions feed.
// Pins the writer-side canonical rules:
//   - a tx with on-chain ids keys player/set/edition/moment/sale onto the
//     int-pair edition with the full column contract;
//   - the HARD canonical guard: a UUID-pair key that survives the hydrate
//     redirect is resolved on-chain or SKIPPED — never written (uuid_skipped
//     accounting in the ingest-canonical-guard pipeline row);
//   - the Item-B hydrate redirect rewrites UUID-pair keys to int-pair before
//     any edition row lands (the sentinel's UUID-leak tripwire class);
//   - subedition keying (flag-gated) widens the base key ONLY from the
//     authoritative on-chain submap and never writes base circulation onto a
//     ::subID parallel row.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  chained: [] as Array<{ path: string; chain: boolean }>,
  gqlResponse: null as unknown,
  hydrateResults: [] as Array<Record<string, unknown>>,
  hydrateCalledWith: [] as string[][],
}))

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>()
  return { ...actual, after: (cb: () => unknown) => void state.afterCbs.push(cb) }
})
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/pipeline-chain", () => ({
  fireNextPipelineStep: async (path: string, chain: boolean) =>
    void state.chained.push({ path, chain }),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => state.gqlResponse,
}))
vi.mock("@/lib/editions-hydrate", () => ({
  hydrateTopShotEditions: async (missing: string[]) => {
    state.hydrateCalledWith.push(missing)
    return state.hydrateResults
  },
  toUpsertRow: (r: Record<string, unknown>) => ({
    external_id: r.external_id,
    collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    name: "Hydrated Edition",
  }),
}))

const { POST } = await import("@/app/api/ingest/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

interface TxOverrides {
  flowId?: string | null
  setFlowId?: number | null
  playFlowID?: string | null
  price?: number
  txHash?: string
  serial?: string
}

function saleTx(o: TxOverrides = {}) {
  return {
    id: `tx-${o.txHash ?? "h1"}`,
    price: o.price ?? 12,
    updatedAt: "2026-07-17T10:00:00Z",
    txHash: o.txHash ?? "0x" + "a".repeat(64),
    moment: {
      id: "moment-uuid-1",
      flowId: o.flowId === undefined ? "555" : o.flowId,
      flowSerialNumber: o.serial ?? "9",
      tier: "TIER_COMMON",
      isLocked: false,
      parallelID: null,
      set: {
        id: "set-uuid-1",
        flowId: o.setFlowId === undefined ? 3 : o.setFlowId,
        flowName: "Base Set",
        flowSeriesNumber: 5,
      },
      setPlay: {
        ID: "sp-1",
        flowRetired: false,
        circulations: { circulationCount: 15000, forSaleByCollectors: 10, locked: 5 },
      },
      parallelSetPlay: null,
      play: {
        id: "play-uuid-1",
        flowID: o.playFlowID === undefined ? "45" : o.playFlowID,
        stats: {
          playerID: "player-ext-1",
          playerName: "Damian Lillard",
          firstName: "Damian",
          lastName: "Lillard",
          jerseyNumber: "0",
          teamAtMoment: "Portland Trail Blazers",
          playCategory: "Dunk",
          dateOfMoment: "2026-01-15T00:00:00Z",
        },
      },
    },
  }
}

function gqlFeed(txs: unknown[]) {
  return {
    searchMarketplaceTransactions: {
      data: {
        searchSummary: {
          pagination: { rightCursor: "cursor-2" },
          data: [{ size: txs.length, data: txs }],
        },
      },
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    collections: { data: { id: TOPSHOT }, error: null },
    // players are resolved through the canonical SECDEF resolver, NOT a table
    // upsert — see the "canonical player resolution" block below.
    "rpc:upsert_player_canonical": { data: "player-db-1", error: null },
    sets: { data: { id: "set-db-1" }, error: null },
    moments: { data: null, error: null },
    sales: { data: null, error: null },
    pipeline_runs: { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function req(): NextRequest {
  return new NextRequest("https://t/api/ingest", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      authorization: "Bearer ingest-token",
    }),
    body: "{}",
  })
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-token"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  delete process.env.TOPSHOT_SUBEDITION_KEYING
  state.afterCbs.length = 0
  state.chained.length = 0
  state.gqlResponse = gqlFeed([])
  state.hydrateResults = []
  state.hydrateCalledWith = []
  fetchMock = installFetchMock([jsonRoute("ts-proxy.test", { data: null })])
})

describe("ingest — canonical player resolution (duplicate factory + stale-team clobber)", () => {
  // Guards audit_20260802_upsert_player_canonical. Both defects were LIVE on
  // 2026-08-02 and both came from one blind `.from("players").upsert()`:
  //   * it arbitrated on (external_id, collection_id) while `players` carries a
  //     STRICTER GLOBAL UNIQUE(external_id), so a human already stored under the
  //     `<coll_slug>-<name-slug>` scheme was invisible and got a SECOND row
  //     (John Havlicek existed twice);
  //   * it wrote `team = stats.teamAtMoment` — the team at the time of the
  //     MOMENT — on every sale, silently undoing the derived current-team fix
  //     (148 rows repaired at 12:40Z, 23 re-broken by 16:38Z; Jrue Holiday read
  //     "Boston Celtics" while playing in Portland).
  // The route must therefore delegate identity to the DB resolver and never
  // write the players table directly.
  it("delegates to upsert_player_canonical and never upserts the players table", async () => {
    state.gqlResponse = gqlFeed([saleTx({})])
    const spy = install({
      editions: [
        { data: [{ external_id: "3:45" }], error: null },
        { data: { id: "ed-db-1" }, error: null },
      ],
    })

    expect((await POST(req())).status).toBe(200)
    await runDeferred()

    const call = spy.rpcCalls.find((c) => c.name === "upsert_player_canonical")
    expect(call, "ingest must resolve players via the canonical RPC").toBeTruthy()
    expect(call?.args).toMatchObject({
      p_collection_id: TOPSHOT,
      p_external_id: "player-ext-1",
      p_name: "Damian Lillard",
      p_team: "Portland Trail Blazers",
    })

    // teamAtMoment is still PASSED (it may seed a brand-new player) — the
    // fill-only guarantee lives in the SQL function, not here.
    expect(call?.args).toHaveProperty("p_team")

    // The regression that matters: no direct write to `players` may return.
    // If someone reinstates the blind upsert, this reddens.
    const playerWrites = spy.writes.players ?? []
    expect(playerWrites, "players must never be written directly by ingest").toHaveLength(0)
  })
})

describe("ingest — canonical int-pair happy path", () => {
  it("writes player/set/edition/moment/sale keyed on the on-chain int pair with the full column contract", async () => {
    state.gqlResponse = gqlFeed([saleTx({})])
    const spy = install({
      editions: [
        { data: [{ external_id: "3:45" }], error: null }, // hydrate existing check: key known
        { data: { id: "ed-db-1" }, error: null }, // per-tx upsertEdition
      ],
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).message).toBe("Ingest triggered")
    await runDeferred()

    // No hydrate needed — the edition already existed.
    expect(state.hydrateCalledWith).toHaveLength(0)

    const edUpsert = spy.writes.editions?.find((w) => w.method === "upsert")
    expect(edUpsert?.rows[0]).toMatchObject({
      external_id: "3:45",
      collection_id: TOPSHOT,
      tier: "COMMON",
      series: 5,
      edition_kind: "CC",
      circulation_count: 15000,
      set_id_onchain: 3,
      play_id_onchain: 45,
      jersey_number: 0,
      game_date: "2026-01-15",
    })

    const momentUpsert = spy.writes.moments?.find((w) => w.method === "upsert")
    expect(momentUpsert?.rows[0]).toMatchObject({
      nft_id: "555",
      edition_id: "ed-db-1",
      collection_id: TOPSHOT,
      serial_number: 9,
    })

    const saleInsert = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(saleInsert).toHaveLength(1)
    expect(saleInsert[0]).toMatchObject({
      edition_id: "ed-db-1",
      collection_id: TOPSHOT,
      serial_number: 9,
      price_usd: 12,
      marketplace: "topshot",
      source: "topshot_gql",
      nft_id: "555",
      sold_at: "2026-07-17T10:00:00Z",
    })

    expect(state.chained).toEqual([{ path: "/api/sales-indexer", chain: false }])
  })
})

describe("ingest — the HARD canonical guard (mis-attribution writer class)", () => {
  it("Item B: a UUID-pair key is rewritten to int-pair via the hydrate redirect before any row lands", async () => {
    // GQL returns NULL on-chain ids -> buildEditionKey falls back to UUID pair.
    state.gqlResponse = gqlFeed([saleTx({ setFlowId: null, playFlowID: null })])
    // The hydrator resolves the UUID pair to on-chain ids 3:45.
    state.hydrateResults = [
      {
        ok: true,
        redirect: false,
        external_id: "set-uuid-1:play-uuid-1",
        set_id_onchain: 3,
        play_id_onchain: 45,
      },
    ]
    const spy = install({
      editions: [
        { data: [], error: null }, // existing check: key unknown -> hydrate
        { data: null, error: null }, // hydrate bulk upsert ack
        { data: { id: "ed-db-2" }, error: null }, // per-tx upsertEdition
      ],
    })

    await POST(req())
    await runDeferred()

    // The hydrate bulk upsert wrote the INT-pair row, not the UUID pair.
    const bulk = spy.writes.editions?.find((w) => w.method === "upsert")
    expect(bulk?.rows[0]).toMatchObject({ external_id: "3:45", name: "Hydrated Edition" })

    // The per-tx edition upsert also keyed on the int pair (uuidToInt swap)...
    const perTx = spy.writes.editions?.filter((w) => w.method === "upsert").at(-1)
    expect(perTx?.rows[0]).toMatchObject({ external_id: "3:45", set_id_onchain: 3, play_id_onchain: 45 })
    // ...and the sale landed.
    expect((spy.writes.sales ?? []).flatMap((w) => w.rows)).toHaveLength(1)

    // Observability row for the hydrate site carries the redirect count.
    const hydrateRun = (spy.writes.pipeline_runs ?? [])
      .flatMap((w) => w.rows)
      .find((r) => r.pipeline === "editions-hydrate-at-insert")
    expect((hydrateRun?.extra as Record<string, unknown>).uuid_to_int_redirected).toBe(1)
  })

  it("last-resort on-chain resolve: an unhydratable UUID key is resolved via getMintedMoment", async () => {
    state.gqlResponse = gqlFeed([saleTx({ setFlowId: null, playFlowID: null })])
    // Hydrator can't map it (no on-chain ids resolved).
    state.hydrateResults = [
      { ok: false, redirect: false, external_id: "set-uuid-1:play-uuid-1", set_id_onchain: null, play_id_onchain: null },
    ]
    fetchMock?.restore()
    fetchMock = installFetchMock([
      jsonRoute("ts-proxy.test", {
        data: { getMintedMoment: { data: { play: { flowID: "34" }, set: { flowId: 12 } } } },
      }),
    ])
    const spy = install({
      editions: [
        { data: [], error: null },
        { data: null, error: null },
        { data: { id: "ed-db-3" }, error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    // The per-tx edition landed on the chain-resolved int pair.
    const perTx = spy.writes.editions?.filter((w) => w.method === "upsert").at(-1)
    expect(perTx?.rows[0]).toMatchObject({ external_id: "12:34" })
    expect((spy.writes.sales ?? []).flatMap((w) => w.rows)).toHaveLength(1)

    // The canonical-guard telemetry row records the rescue.
    const guardRun = (spy.writes.pipeline_runs ?? [])
      .flatMap((w) => w.rows)
      .find((r) => r.pipeline === "ingest-canonical-guard")
    expect(guardRun).toMatchObject({ rows_written: 1, rows_skipped: 0 })
  })

  it("when the chain cannot resolve either, the tx is SKIPPED — never written onto a UUID-dupe edition", async () => {
    state.gqlResponse = gqlFeed([saleTx({ setFlowId: null, playFlowID: null })])
    state.hydrateResults = [
      { ok: false, redirect: false, external_id: "set-uuid-1:play-uuid-1", set_id_onchain: null, play_id_onchain: null },
    ]
    // getMintedMoment returns nothing usable.
    const spy = install({
      editions: [
        { data: [], error: null },
        { data: null, error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    // NO sale, NO moment, NO per-tx edition write happened for the UUID key.
    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.moments ?? []).toHaveLength(0)
    const upserts = (spy.writes.editions ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    expect(upserts.every((r) => r.external_id !== "set-uuid-1:play-uuid-1" || r.name === "Hydrated Edition")).toBe(true)

    const guardRun = (spy.writes.pipeline_runs ?? [])
      .flatMap((w) => w.rows)
      .find((r) => r.pipeline === "ingest-canonical-guard")
    expect(guardRun).toMatchObject({ rows_written: 0, rows_skipped: 1 })
  })
})

describe("ingest — subedition (parallel) keying, flag-gated", () => {
  it("widens the base key from the authoritative on-chain submap and never writes base circ onto the parallel", async () => {
    process.env.TOPSHOT_SUBEDITION_KEYING = "1"
    state.gqlResponse = gqlFeed([saleTx({})])
    const spy = install({
      topshot_moment_subeditions: { data: [{ nft_id: "555", subedition_id: 19 }], error: null },
      editions: [
        { data: [{ external_id: "3:45::19" }], error: null }, // existing check
        { data: { id: "ed-par-1" }, error: null }, // per-tx upsert
      ],
    })

    await POST(req())
    await runDeferred()

    const edUpsert = spy.writes.editions?.find((w) => w.method === "upsert")
    expect(edUpsert?.rows[0]).toMatchObject({
      external_id: "3:45::19",
      subedition_id: 19,
      subedition_name: "Hexwave",
      // Base still parses out of the ::key for the on-chain id columns.
      set_id_onchain: 3,
      play_id_onchain: 45,
    })
    // The base-gross circulation must NOT be written onto the parallel row.
    expect("circulation_count" in (edUpsert?.rows[0] ?? {})).toBe(false)

    const sale = (spy.writes.sales ?? []).flatMap((w) => w.rows)
    expect(sale[0]).toMatchObject({ edition_id: "ed-par-1" })
  })

  it("flag OFF: the same nft stays on the base key even when the submap has a parallel row", async () => {
    state.gqlResponse = gqlFeed([saleTx({})])
    const spy = install({
      // Even if this table were consulted, keying must stay base with the flag off.
      topshot_moment_subeditions: { data: [{ nft_id: "555", subedition_id: 19 }], error: null },
      editions: [
        { data: [{ external_id: "3:45" }], error: null },
        { data: { id: "ed-base-1" }, error: null },
      ],
    })

    await POST(req())
    await runDeferred()

    const edUpsert = spy.writes.editions?.find((w) => w.method === "upsert")
    expect(edUpsert?.rows[0]).toMatchObject({ external_id: "3:45", circulation_count: 15000 })
  })
})

describe("ingest — guards", () => {
  it("401s on a wrong bearer token when the secret is configured", async () => {
    install({})
    const res = await POST(
      new NextRequest("https://t/api/ingest", {
        method: "POST",
        headers: new Headers({ authorization: "Bearer wrong", "content-type": "application/json" }),
        body: "{}",
      }),
    )
    expect(res.status).toBe(401)
    expect(state.afterCbs).toHaveLength(0)
  })

  it("skips zero-price and stats-less transactions without writing anything", async () => {
    const noStats = saleTx({ txHash: "0x" + "b".repeat(64) })
    ;(noStats.moment.play as { stats: unknown }).stats = null
    state.gqlResponse = gqlFeed([saleTx({ price: 0 }), noStats])
    const spy = install({
      editions: { data: [{ external_id: "3:45" }], error: null },
    })

    await POST(req())
    await runDeferred()

    expect(spy.writes.sales ?? []).toHaveLength(0)
    expect(spy.writes.moments ?? []).toHaveLength(0)
  })
})
