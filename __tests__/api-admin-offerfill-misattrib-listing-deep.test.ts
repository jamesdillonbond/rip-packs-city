import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  type FetchStub,
} from "./helpers/route-harness"
import { adminReq } from "./helpers/admin-req"

// Deep-loop tests for three operator drains:
//
//   /api/admin/backfill-offer-fill-sales — the OffersV2 accepted-offer sale
//     recovery (INGEST bearer; event_cursor-bounded Flow REST walk; the real
//     parseOfferCompletedFill runs against base64 JSON-CDC payloads, with the
//     DB-writing lib fns recorded).
//   /api/admin/drain-topshot-misattribution — getMintedMoment re-keying of the
//     mis-attribution residual (RPC_ADMIN/INGEST/CRON; map-then-rekey, probe
//     mode, the wmc/p8 target-pool swaps, and the 2026-07-10 fatal-logger).
//   /api/admin/listing-retry-force — single-row AllDay listing resolver
//     (INGEST/RPC_ADMIN; wmc → nft_edition_map → Cadence borrow ladder).

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
  buildCalls: [] as unknown[][],
  insertCalls: [] as unknown[][],
  stampCalls: [] as unknown[][],
  insertResult: { inserted: 0, duped: 0 },
  builtUnresolved: 0,
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

// Keep the REAL parseOfferCompletedFill (so the route's base64+JSON-CDC unwrap
// is exercised end-to-end); record/stub only the three DB-writing lib fns.
vi.mock("@/lib/chains/flow/topshot-offer-fill", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chains/flow/topshot-offer-fill")>()
  return {
    ...actual,
    buildOfferFillSales: async (fills: unknown[]) => {
      state.buildCalls.push(fills)
      return {
        rows: fills.map((_f, i) => ({ synthetic_sale: i })),
        unresolved: state.builtUnresolved,
        serialsResolved: 0,
        parallelRedirects: 0,
      }
    },
    insertOfferFillSales: async (rows: unknown[]) => {
      state.insertCalls.push(rows)
      return state.insertResult
    },
    stampOfferFillTxHashes: async (fills: unknown[]) => {
      state.stampCalls.push(fills)
      return { stamped: fills.length }
    },
  }
})

// backfill-offer-fill-sales captures INGEST_SECRET_TOKEN at module load.
process.env.INGEST_SECRET_TOKEN = "ingest-secret"

const offerFill = await import("@/app/api/admin/backfill-offer-fill-sales/route")
const misattrib = await import("@/app/api/admin/drain-topshot-misattribution/route")
const retryForce = await import("@/app/api/admin/listing-retry-force/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  process.env.RPC_ADMIN_TOKEN = "admin-token"
  process.env.CRON_SECRET = "cron-secret"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  process.env.TS_PROXY_SECRET = "proxy-secret"
  state.afterCbs.length = 0
  state.buildCalls.length = 0
  state.insertCalls.length = 0
  state.stampCalls.length = 0
  state.insertResult = { inserted: 0, duped: 0 }
  state.builtUnresolved = 0
  install({})
})

afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})

// ── backfill-offer-fill-sales ────────────────────────────────────────────────

/** Base64 JSON-CDC OfferCompleted payload, the exact wire shape the route decodes. */
function cdcOfferCompleted(opts: {
  purchased?: boolean
  offerId?: string
  amount?: string
  setId?: string
  playId?: string
}): string {
  const cdc = {
    type: "Event",
    value: {
      id: "A.b8ea91944fd51c43.OffersV2.OfferCompleted",
      fields: [
        { name: "purchased", value: { type: "Bool", value: opts.purchased ?? true } },
        { name: "offerId", value: { type: "UInt64", value: opts.offerId ?? "9001" } },
        {
          name: "nftType",
          value: { type: "Type", value: { staticType: { typeID: "A.0b2a3299cc857e29.TopShot.NFT" } } },
        },
        { name: "offerAmount", value: { type: "UFix64", value: opts.amount ?? "25.00000000" } },
        { name: "offerAddress", value: { type: "Address", value: "0xABCDEF0123456789" } },
        {
          name: "acceptingAddress",
          value: { type: "Optional", value: { type: "Address", value: "0x1111222233334444" } },
        },
        { name: "nftId", value: { type: "Optional", value: { type: "UInt64", value: "777" } } },
        {
          name: "offerParamsString",
          value: {
            type: "Dictionary",
            value: [
              { key: { type: "String", value: "_type" }, value: { type: "String", value: "TopShotEdition" } },
              { key: { type: "String", value: "setId" }, value: { type: "String", value: opts.setId ?? "231" } },
              { key: { type: "String", value: "playId" }, value: { type: "String", value: opts.playId ?? "4567" } },
            ],
          },
        },
      ],
    },
  }
  return Buffer.from(JSON.stringify(cdc), "utf8").toString("base64")
}

const SEALED_AT = (h: number): FetchStub => jsonRoute("blocks?height=sealed", [{ header: { height: String(h) } }])

describe("/api/admin/backfill-offer-fill-sales", () => {
  it("POST 401s without the ingest token; GET is an unauthenticated cursor-status read", async () => {
    expect((await offerFill.POST(adminReq("https://t/api/admin/backfill-offer-fill-sales"))).status).toBe(401)
    expect(
      (
        await offerFill.POST(
          adminReq("https://t/api/admin/backfill-offer-fill-sales", { authorization: "Bearer admin-token" }),
        )
      ).status,
    ).toBe(401)

    install({ event_cursor: { data: { last_processed_block: 153650000, updated_at: "2026-07-16T00:00:00Z" }, error: null } })
    const res = await offerFill.GET()
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      cursor: { last_processed_block: 153650000 },
      defaultStart: 153_600_000,
    })
  })

  it("?sync=1 decodes real CDC fills, writes sales via the builder, stamps offers, and advances the cursor to done", async () => {
    const spy = install({
      event_cursor: { data: null, error: null }, // no cursor → DEFAULT_START-1
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    state.insertResult = { inserted: 1, duped: 0 }
    fetchMock = installFetchMock([
      SEALED_AT(153_600_100),
      jsonRoute("/v1/events", [
        {
          block_height: "153600050",
          block_timestamp: "2026-07-17T00:00:00Z",
          events: [
            { type: "A.b8ea91944fd51c43.OffersV2.OfferCompleted", transaction_id: "txabc", payload: cdcOfferCompleted({}), event_index: 0 },
            // Cancelled (purchased=false) — parsed to null, never a fill.
            { type: "A.b8ea91944fd51c43.OffersV2.OfferCompleted", transaction_id: "txdef", payload: cdcOfferCompleted({ purchased: false }), event_index: 1 },
            // Malformed payload — skipped silently.
            { type: "A.b8ea91944fd51c43.OffersV2.OfferCompleted", transaction_id: "txbad", payload: "!!!not-base64-json!!!", event_index: 2 },
          ],
        },
      ]),
    ])

    const res = await offerFill.POST(
      adminReq("https://t/api/admin/backfill-offer-fill-sales?sync=1&range=250", { authorization: "Bearer ingest-secret" }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      error: null,
      cursor_before: "153599999",
      cursor_after: "153600100",
      pages: 1,
      fills_seen: 1,
      sales_written: 1,
      sales_duped: 0,
      offers_stamped: 1,
      done: true, // reached the sealed frontier
    })

    // The fill handed to the builder is the fully decoded event, not an echo.
    expect(state.buildCalls).toHaveLength(1)
    expect(state.buildCalls[0][0]).toMatchObject({
      offerId: "9001",
      fillTx: "txabc",
      blockHeight: 153600050,
      buyer: "0xabcdef0123456789", // normalized lowercase
      seller: "0x1111222233334444",
      amount: 25,
      nftId: "777",
      offerType: "edition",
      externalId: "231:4567",
    })
    expect(state.insertCalls[0]).toEqual([{ synthetic_sale: 0 }])
    expect(state.stampCalls[0]).toHaveLength(1)

    // Cursor persisted for the next invocation.
    const cursorWrite = (spy.writes.event_cursor ?? []).find((w) => w.method === "upsert")!
    expect(cursorWrite.rows[0]).toMatchObject({
      id: "topshot_offer_fill_backfill",
      last_processed_block: 153_600_100,
    })

    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log).toMatchObject({
      p_pipeline: "backfill-offer-fill-sales",
      p_rows_found: 1,
      p_rows_written: 1,
      p_rows_skipped: 0,
      p_ok: true,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: "153599999",
      p_cursor_after: "153600100",
    })
  })

  it("no-ops with 'backfill complete' once the cursor reaches the sealed frontier", async () => {
    const spy = install({
      event_cursor: { data: { last_processed_block: 153_600_100 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    fetchMock = installFetchMock([SEALED_AT(153_600_100)])

    const res = await offerFill.POST(
      adminReq("https://t/api/admin/backfill-offer-fill-sales?sync=1", { authorization: "Bearer ingest-secret" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, done: true, message: "backfill complete", current_height: 153_600_100 })
    expect(state.buildCalls).toHaveLength(0)
    expect((spy.writes.event_cursor ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    expect(spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args).toMatchObject({ p_ok: true })
  })

  it("?start_block overrides the cursor and a sealed-height failure degrades to ok=false with the error logged", async () => {
    install({ event_cursor: { data: { last_processed_block: 1 }, error: null }, "rpc:log_pipeline_run": { data: null, error: null } })
    fetchMock = installFetchMock([
      SEALED_AT(153_700_050),
      jsonRoute("/v1/events", []),
    ])
    const res = await offerFill.POST(
      adminReq("https://t/api/admin/backfill-offer-fill-sales?sync=1&start_block=153700000&range=250", { authorization: "Bearer ingest-secret" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, cursor_before: "153699999", cursor_after: "153700050", fills_seen: 0 })
    fetchMock.restore()

    const spy2 = install({ event_cursor: { data: null, error: null }, "rpc:log_pipeline_run": { data: null, error: null } })
    fetchMock = installFetchMock([jsonRoute("blocks?height=sealed", {}, { status: 500 })])
    const res2 = await offerFill.POST(
      adminReq("https://t/api/admin/backfill-offer-fill-sales?sync=1", { authorization: "Bearer ingest-secret" }),
    )
    const body2 = await res2.json()
    expect(body2.ok).toBe(false)
    expect(body2.error).toContain("blocks sealed HTTP 500")
    expect(spy2.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args).toMatchObject({ p_ok: false })
  })

  it("the default (non-sync) path defers the drain via after() and acks 202 immediately", async () => {
    install({
      event_cursor: { data: { last_processed_block: 153_600_100 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    fetchMock = installFetchMock([SEALED_AT(153_600_100)])

    const res = await offerFill.POST(
      adminReq("https://t/api/admin/backfill-offer-fill-sales", { authorization: "Bearer ingest-secret" }),
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: "accepted" })
    expect(state.afterCbs).toHaveLength(1)
    await state.afterCbs[0]() // the deferred drain runs to completion
    state.afterCbs.length = 0
  })
})

// ── drain-topshot-misattribution ─────────────────────────────────────────────

describe("/api/admin/drain-topshot-misattribution", () => {
  it("accepts INGEST (alt family) and 401s unauthenticated", async () => {
    expect((await misattrib.GET(adminReq("https://t/api/admin/drain-topshot-misattribution"))).status).toBe(401)
    install({ "rpc:topshot_misattrib_drain_targets": { data: [], error: null } })
    const res = await misattrib.GET(
      adminReq("https://t/api/admin/drain-topshot-misattribution", { authorization: "Bearer ingest-secret" }),
    )
    expect(await res.json()).toMatchObject({ ok: true, pipeline: "topshot-misattrib-drain", targets: 0, note: "no unresolved targets" })
  })

  it("resolves targets via aliased getMintedMoment through the proxy and upserts the authoritative on-chain map", async () => {
    const spy = install({
      "rpc:topshot_misattrib_drain_targets": { data: [{ nft_id: "111" }, { nft_id: "222" }], error: null },
      topshot_misattrib_onchain_map: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([
      jsonRoute("ts-proxy.test", {
        data: {
          m0: { data: { flowSerialNumber: "12", play: { flowID: "6563" }, set: { flowId: 165 } } },
          m1: { data: null }, // unresolvable — counted, never guessed
        },
      }),
    ])

    const res = await misattrib.POST(
      adminReq("https://t/api/admin/drain-topshot-misattribution?limit=50", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      pipeline: "topshot-misattrib-drain",
      targets: 2,
      resolved: 1,
      gql_failed: 1,
      map_written: 1,
      rekey: null, // no ?rekey=1 → resolution only
      terminated_reason: "targets_exhausted",
    })

    // ?limit flows into the targets RPC.
    expect(spy.rpcCalls[0]).toEqual({ name: "topshot_misattrib_drain_targets", args: { p_limit: 50 } })

    // One aliased chunk through the proxy with the secret header.
    expect(fetchMock.calls).toHaveLength(1)
    const headers = fetchMock.calls[0].init?.headers as Record<string, string>
    expect(headers["X-Proxy-Secret"]).toBe("proxy-secret")
    const gqlReq = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(gqlReq.variables).toEqual({ id0: "111", id1: "222" })
    expect(gqlReq.query).toContain("m0: getMintedMoment(momentId: $id0)")

    // Authoritative map row: parsed ints, serial preserved.
    const mapWrite = (spy.writes.topshot_misattrib_onchain_map ?? []).find((w) => w.method === "upsert")!
    expect(mapWrite.rows).toHaveLength(1)
    expect(mapWrite.rows[0]).toMatchObject({
      nft_id: "111",
      set_id_onchain: 165,
      play_id_onchain: 6563,
      serial_number: 12,
    })

    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({
      pipeline: "topshot-misattrib-drain",
      rows_found: 2,
      rows_written: 1,
      rows_skipped: 1,
      ok: true,
    })
  })

  it("?probe=1 resolves without writing the map", async () => {
    const spy = install({
      "rpc:topshot_misattrib_drain_targets": { data: [{ nft_id: "111" }], error: null },
    })
    fetchMock = installFetchMock([
      jsonRoute("ts-proxy.test", {
        data: { m0: { data: { flowSerialNumber: "3", play: { flowID: "10" }, set: { flowId: 4 } } } },
      }),
    ])
    const res = await misattrib.POST(
      adminReq("https://t/api/admin/drain-topshot-misattribution?probe=1", { authorization: "Bearer admin-token" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, mode: "probe", targets: 1, resolved: 1 })
    expect(body.samples).toEqual([{ nft_id: "111", set_id_onchain: 4, play_id_onchain: 10, serial_number: 3 }])
    expect(spy.writes.topshot_misattrib_onchain_map ?? []).toHaveLength(0)
    expect(spy.writes.pipeline_runs ?? []).toHaveLength(0)
  })

  it("?wmc=1 / ?p8=1 swap the target pool, pipeline identity, and re-key RPC", async () => {
    for (const [qs, pipeline, targetsRpc, rekeyRpc] of [
      ["wmc=1", "topshot-wmc-fossil-drain", "topshot_wmc_fossil_targets", "remap_topshot_wmc_from_onchain_map"],
      ["p8=1", "topshot-p8-moment-drain", "topshot_p8_corrupt_moment_targets", "remap_topshot_from_onchain_map"],
    ] as const) {
      const spy = install({
        [`rpc:${targetsRpc}`]: { data: [{ nft_id: "111" }], error: null },
        [`rpc:${rekeyRpc}`]: { data: { sales_rekeyed: 7 }, error: null },
        topshot_misattrib_onchain_map: { data: null, error: null },
        pipeline_runs: { data: null, error: null },
      })
      fetchMock?.restore()
      fetchMock = installFetchMock([
        jsonRoute("ts-proxy.test", {
          data: { m0: { data: { flowSerialNumber: "1", play: { flowID: "2" }, set: { flowId: 3 } } } },
        }),
      ])
      const res = await misattrib.POST(
        adminReq(`https://t/api/admin/drain-topshot-misattribution?${qs}&rekey=1`, { authorization: "Bearer admin-token" }),
      )
      const body = await res.json()
      expect(body).toMatchObject({ pipeline, rekey: { sales_rekeyed: 7 } })
      expect(spy.rpcCalls.map((c) => c.name)).toEqual([targetsRpc, rekeyRpc])
    }
  })

  it("a targets-RPC failure 500s AND writes the stage-tagged pipeline_runs row (the 07-07..07-10 silent class)", async () => {
    const spy = install({
      "rpc:topshot_misattrib_drain_targets": { data: null, error: { message: "statement timeout" } },
      pipeline_runs: { data: null, error: null },
    })
    const res = await misattrib.POST(
      adminReq("https://t/api/admin/drain-topshot-misattribution", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("targets: statement timeout")
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ ok: false, error: "targets: statement timeout" })
    expect(runRow.extra).toMatchObject({ stage: "targets_rpc", rpc: "topshot_misattrib_drain_targets" })
  })

  it("a proxy failure degrades honestly: all-chunk gql_failed, ok=false, error sampled", async () => {
    install({
      "rpc:topshot_misattrib_drain_targets": { data: [{ nft_id: "111" }, { nft_id: "222" }], error: null },
      topshot_misattrib_onchain_map: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([jsonRoute("ts-proxy.test", {}, { status: 503 })])
    const res = await misattrib.POST(
      adminReq("https://t/api/admin/drain-topshot-misattribution", { authorization: "Bearer admin-token" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, resolved: 0, gql_failed: 2, map_written: 0 })
    expect(body.errors).toEqual(["HTTP 503"])
  })

  it("an uncaught throw hits the fatal crash-logger: 500 with detail instead of a zero-output crash", async () => {
    state.sb = {
      rpc: () => {
        throw new Error("kaboom mid-flight")
      },
    }
    const res = await misattrib.POST(
      adminReq("https://t/api/admin/drain-topshot-misattribution", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("fatal")
    expect(body.detail).toContain("kaboom mid-flight")
  })
})

// ── listing-retry-force ──────────────────────────────────────────────────────

const ALLDAY_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const EVENT_PAYLOAD = {
  blockHeight: 156_000_000,
  blockTimestamp: "2026-07-15T10:00:00Z",
  txHash: "txhash1",
  eventIndex: 4,
  listingResourceID: "lr-900",
  storefrontAddress: "0x9999888877776666",
  nftID: "424242",
  salePrice: "42.50000000",
  salePaymentVaultType: "A.ead892083b3e2c6c.DapperUtilityCoin.Vault",
  customID: "allday-custom",
  expiry: "1790000000",
}

function failureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 12,
    collection_id: ALLDAY_ID,
    flow_id: "424242",
    listing_resource_id: "lr-900",
    event_payload: EVENT_PAYLOAD,
    retry_count: 3,
    resolved_at: null,
    ...overrides,
  }
}

describe("POST /api/admin/listing-retry-force", () => {
  const URL_OK = "https://t/api/admin/listing-retry-force?id=12"

  it("guards: 401 unauth, 400 non-numeric id, 404 unknown row, already-resolved short-circuit, 501 non-AllDay", async () => {
    expect((await retryForce.POST(adminReq(URL_OK))).status).toBe(401)
    expect(
      (await retryForce.POST(adminReq("https://t/api/admin/listing-retry-force?id=abc", { authorization: "Bearer admin-token" }))).status,
    ).toBe(400)

    install({ listing_resolution_failures: { data: null, error: null } })
    expect((await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))).status).toBe(404)

    install({ listing_resolution_failures: { data: failureRow({ resolved_at: "2026-07-16T00:00:00Z" }), error: null } })
    const done = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer ingest-secret" }))
    expect(await done.json()).toMatchObject({ ok: true, already_resolved: true, resolved_at: "2026-07-16T00:00:00Z" })

    install({ listing_resolution_failures: { data: failureRow({ collection_id: "not-allday" }), error: null } })
    const wrong = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(wrong.status).toBe(501)
    expect((await wrong.json()).error).toContain("only supports AllDay")
  })

  it("resolves via the wmc edition_key and writes the computed cached_listings_v2 row (DUC → USD)", async () => {
    const spy = install({
      listing_resolution_failures: [
        { data: failureRow(), error: null },
        { data: null, error: null }, // resolved-mark update
      ],
      wallet_moments_cache: { data: { edition_key: "100:200" }, error: null },
      editions: { data: { id: "edition-uuid-1" }, error: null },
      cached_listings_v2: { data: null, error: null },
    })

    const res = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      ok: true,
      resolved: true,
      edition_id: "edition-uuid-1",
      external_id: "100:200",
      cadence_tried: false, // wmc hit → no on-chain borrow needed
    })

    const upsert = (spy.writes.cached_listings_v2 ?? []).find((w) => w.method === "upsert")!
    expect(upsert.rows[0]).toMatchObject({
      listing_resource_id: "lr-900",
      source: "direct",
      flow_id: "424242",
      edition_id: "edition-uuid-1",
      collection_id: ALLDAY_ID,
      seller_address: "0x9999888877776666",
      price_usd: 42.5, // DUC is USD-equivalent
      currency: "DUC",
      custom_id: "allday-custom",
      listed_at: "2026-07-15T10:00:00Z",
      expiry_at: new Date(1_790_000_000 * 1000).toISOString(), // epoch-seconds → ISO
      block_height: 156_000_000,
      tx_hash: "txhash1",
      event_index: 4,
    })

    // The failure row is closed out.
    const marks = (spy.writes.listing_resolution_failures ?? []).filter((w) => w.method === "update")
    expect(marks).toHaveLength(1)
    expect(Object.keys(marks[0].rows[0]).sort()).toEqual(["last_retry_at", "resolved_at"])
  })

  it("a non-USD vault leaves price_usd null with the raw currency preserved", async () => {
    const spy = install({
      listing_resolution_failures: [
        {
          data: failureRow({
            event_payload: { ...EVENT_PAYLOAD, salePaymentVaultType: "A.1654653399040a61.FlowToken.Vault", salePrice: "100.0" },
          }),
          error: null,
        },
        { data: null, error: null },
      ],
      wallet_moments_cache: { data: { edition_key: "100:200" }, error: null },
      editions: { data: { id: "edition-uuid-1" }, error: null },
      cached_listings_v2: { data: null, error: null },
    })
    await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    const upsert = (spy.writes.cached_listings_v2 ?? []).find((w) => w.method === "upsert")!
    expect(upsert.rows[0]).toMatchObject({ currency: "FLOW", price_usd: null })
  })

  it("falls through wmc → nft_edition_map, and reports an unmatchable external id honestly", async () => {
    // nft_edition_map hit.
    install({
      listing_resolution_failures: [{ data: failureRow(), error: null }, { data: null, error: null }],
      wallet_moments_cache: { data: null, error: null },
      nft_edition_map: { data: { edition_external_id: "300:400" }, error: null },
      editions: { data: { id: "edition-uuid-2" }, error: null },
      cached_listings_v2: { data: null, error: null },
    })
    const res = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(await res.json()).toMatchObject({ resolved: true, external_id: "300:400", cadence_tried: false })

    // external id resolves but isn't in editions → honest non-resolution + retry bump.
    const spy2 = install({
      listing_resolution_failures: [{ data: failureRow(), error: null }, { data: null, error: null }],
      wallet_moments_cache: { data: { edition_key: "100:200" }, error: null },
      editions: { data: null, error: null },
    })
    const res2 = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(await res2.json()).toMatchObject({
      ok: true,
      resolved: false,
      next_retry_count: 4,
      reason: "external_id_not_in_editions_table",
      external_id_found: "100:200",
    })
    const bump = (spy2.writes.listing_resolution_failures ?? []).filter((w) => w.method === "update")
    expect(bump[0].rows[0]).toMatchObject({ retry_count: 4 })
  })

  it("last-resort Cadence borrow: decodes the script result for the editionID; a nil borrow bumps retry_count", async () => {
    // Cadence returns a Dictionary with editionID → resolved.
    const dictResult = Buffer.from(
      JSON.stringify({
        type: "Optional",
        value: {
          type: "Dictionary",
          value: [
            { key: { type: "String", value: "id" }, value: { type: "String", value: "424242" } },
            { key: { type: "String", value: "editionID" }, value: { type: "String", value: "555" } },
            { key: { type: "String", value: "serialNumber" }, value: { type: "String", value: "9" } },
          ],
        },
      }),
      "utf8",
    ).toString("base64")
    install({
      listing_resolution_failures: [{ data: failureRow(), error: null }, { data: null, error: null }],
      wallet_moments_cache: { data: null, error: null },
      nft_edition_map: { data: null, error: null },
      editions: { data: { id: "edition-uuid-3" }, error: null },
      cached_listings_v2: { data: null, error: null },
    })
    fetchMock = installFetchMock([jsonRoute("/v1/scripts", dictResult)])

    const res = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(await res.json()).toMatchObject({
      ok: true,
      resolved: true,
      edition_id: "edition-uuid-3",
      external_id: "555",
      cadence_tried: true,
    })
    expect(fetchMock.calls[0].url).toContain("/v1/scripts")
    fetchMock.restore()
    fetchMock = null

    // Nil borrow (Optional null) → no external id anywhere → retry bump.
    const nilResult = Buffer.from(JSON.stringify({ type: "Optional", value: null }), "utf8").toString("base64")
    const spy2 = install({
      listing_resolution_failures: [{ data: failureRow(), error: null }, { data: null, error: null }],
      wallet_moments_cache: { data: null, error: null },
      nft_edition_map: { data: null, error: null },
    })
    fetchMock = installFetchMock([jsonRoute("/v1/scripts", nilResult)])
    const res2 = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(await res2.json()).toMatchObject({
      resolved: false,
      cadence_tried: true,
      reason: "no_external_id_resolved",
      next_retry_count: 4,
    })
    expect((spy2.writes.listing_resolution_failures ?? []).filter((w) => w.method === "update")[0].rows[0]).toMatchObject({ retry_count: 4 })
  })

  it("a cached_listings_v2 upsert failure 500s with the wrapped message", async () => {
    install({
      listing_resolution_failures: { data: failureRow(), error: null },
      wallet_moments_cache: { data: { edition_key: "100:200" }, error: null },
      editions: { data: { id: "edition-uuid-1" }, error: null },
      cached_listings_v2: { data: null, error: { message: "duplicate key" } },
    })
    const res = await retryForce.POST(adminReq(URL_OK, { authorization: "Bearer admin-token" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("v2 upsert: duplicate key")
  })
})
