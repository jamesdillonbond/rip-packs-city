import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
  gqlRoute,
  type FetchStub,
} from "./helpers/route-harness"
import { adminReq } from "./helpers/admin-req"

// Deep-loop tests for the two catalog walkers:
//
//   /api/admin/backfill-topshot-catalog   (RPC_ADMIN_TOKEN ONLY — synchronous
//     set-by-set GQL walk that upserts `editions` keyed on the int-pair
//     external_id and stamps the parent `sets` row)
//   /api/admin/backfill-pinnacle-catalog  (RPC_ADMIN or INGEST or CRON —
//     202+after() studio-platform GQL pager that upserts `pinnacle_catalog`
//     keyed on render_id, then the best-effort floor-ask sweep)
//
// Asserts handler-COMPUTED output: the CDN URL construction off assetPathPrefix
// (the post-2026-05-12 long-path form), tier normalization, int-pair keying,
// cover-art only-when-missing semantics, the render_id keying +
// legacy_edition_key composition, first-seen-wins floor reduction, and the
// pipeline_runs / log_pipeline_run observability rows.

const state = vi.hoisted(() => ({
  afterCbs: [] as Array<() => unknown>,
  sb: null as unknown,
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

const tsCatalog = await import("@/app/api/admin/backfill-topshot-catalog/route")
const pinCatalog = await import("@/app/api/admin/backfill-pinnacle-catalog/route")

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

async function runDeferred() {
  const cbs = [...state.afterCbs]
  state.afterCbs.length = 0
  for (const cb of cbs) await cb()
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = "admin-token"
  process.env.INGEST_SECRET_TOKEN = "ingest-secret"
  process.env.CRON_SECRET = "cron-secret"
  process.env.TS_PROXY_URL = "https://ts-proxy.test/graphql"
  process.env.TS_PROXY_SECRET = "proxy-secret"
  state.afterCbs.length = 0
  install({})
})

afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})

// ── Top Shot catalog ─────────────────────────────────────────────────────────

const SET_UUID = "11111111-2222-4333-8444-555555555555"

function tsPage(editions: unknown[], rightCursor: string | null) {
  return {
    data: {
      searchEditions: {
        searchSummary: { pagination: { rightCursor }, data: { data: editions } },
      },
    },
  }
}

const KD_EDITION = {
  tier: "MOMENT_TIER_RARE",
  circulationCount: 499,
  assetPathPrefix:
    "https://assets.nbatopshot.com/editions/165_mvp_moments_rare/play-uuid/play_play-uuid_165_mvp_moments_rare_capture_",
  set: { flowId: 165, flowName: "MVP Moments", flowSeriesNumber: 5 },
  play: {
    flowID: "6563",
    stats: {
      playerName: "  Kevin Durant  ",
      teamAtMoment: "Phoenix Suns",
      teamAtMomentNbaId: "1610612756",
      playCategory: "Jump Shot",
      playType: "3 Pointer",
      dateOfMoment: "2026-01-15T03:00:00Z",
    },
  },
}
// No play.flowID → unkeyable → counted as skipped, never written.
const SKIPPED_EDITION = { tier: "MOMENT_TIER_COMMON", set: { flowId: 165 }, play: null }

describe("/api/admin/backfill-topshot-catalog", () => {
  it("is RPC_ADMIN_TOKEN-only: INGEST and CRON bearers are rejected", async () => {
    for (const auth of [undefined, "Bearer ingest-secret", "Bearer cron-secret", "Bearer nope"]) {
      const res = await tsCatalog.POST(
        adminReq("https://t/api/admin/backfill-topshot-catalog", auth ? { authorization: auth } : {}),
      )
      expect(res.status).toBe(401)
    }
  })

  it("walks a set through GQL pagination and upserts int-pair-keyed editions with CDN URLs built off assetPathPrefix", async () => {
    const spy = install({
      sets: [
        {
          data: [
            {
              id: "set-row-1", external_id: SET_UUID, name: "MVP Moments",
              set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
            },
            // Non-UUID external_id (auto_* AllDay mis-categorization) — filtered out.
            {
              id: "set-row-2", external_id: "auto_123", name: "Bogus",
              set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
            },
          ],
          error: null,
        },
        { data: null, error: null }, // subsequent sets updates
      ],
      editions: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([
      gqlRoute("SearchEditionBackfill", [
        tsPage([KD_EDITION], "cursor-2"),
        tsPage([SKIPPED_EDITION], null),
      ]),
    ])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token"),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "natural",
      sets_processed: 1,
      sets_with_cover_set: 1,
      editions_upserted: 1,
      editions_skipped: 1,
      gql_calls: 2, // two pages walked via rightCursor
      terminated_reason: "no_more_sets",
      errors_count: 0,
      last_set_id: "set-row-1",
      resume_hint: "?startAfter=set-row-1",
    })

    // The GQL requests went to the proxy with the secret header and the set UUID.
    expect(fetchMock.calls).toHaveLength(2)
    expect(fetchMock.calls[0].url).toBe("https://ts-proxy.test/graphql")
    const headers = fetchMock.calls[0].init?.headers as Record<string, string>
    expect(headers["X-Proxy-Secret"]).toBe("proxy-secret")
    const req1 = JSON.parse(String(fetchMock.calls[0].init?.body))
    expect(req1.variables.input.filters.bySetIDs).toEqual([SET_UUID])
    // Page 2 resumes from the returned cursor.
    const req2 = JSON.parse(String(fetchMock.calls[1].init?.body))
    expect(req2.variables.input.searchInput.pagination.cursor).toBe("cursor-2")

    // The computed editions row: int-pair key, normalized tier, trimmed names,
    // long-path CDN URLs, sliced game_date.
    const upserts = (spy.writes.editions ?? []).filter((w) => w.method === "upsert")
    expect(upserts).toHaveLength(1)
    expect(upserts[0].rows[0]).toMatchObject({
      external_id: "165:6563",
      collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
      collection: "nba_top_shot",
      set_id: "set-row-1",
      name: "Kevin Durant — MVP Moments",
      player_name: "Kevin Durant",
      set_name: "MVP Moments",
      team_name: "Phoenix Suns",
      tier: "RARE",
      series: 5,
      circulation_count: 499,
      set_id_onchain: 165,
      play_id_onchain: 6563,
      thumbnail_url: `${KD_EDITION.assetPathPrefix}Hero_2880_2880_Transparent.png`,
      video_url: `${KD_EDITION.assetPathPrefix}Animated_1080_1080_Black.mp4`,
      play_type: "3 Pointer",
      play_category: "Jump Shot",
      game_date: "2026-01-15",
    })

    // Parent-set stamp: on-chain id always, cover/prefix filled because missing.
    const setUpdates = (spy.writes.sets ?? []).filter((w) => w.method === "update")
    expect(setUpdates).toHaveLength(1)
    expect(setUpdates[0].rows[0]).toMatchObject({
      set_id_onchain: 165,
      cover_art_url: `${KD_EDITION.assetPathPrefix}Hero_2880_2880_Transparent.png`,
      asset_path_prefix: KD_EDITION.assetPathPrefix,
    })

    // Observability row mirrors the response.
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({
      pipeline: "topshot-catalog-backfill",
      collection_slug: "nba-top-shot",
      rows_found: 1,
      rows_written: 1,
      rows_skipped: 1,
      ok: true,
    })
    expect(runRow.extra).toMatchObject({ gql_calls: 2, terminated_reason: "no_more_sets", mode: "natural" })
  })

  it("marks a GQL-empty set processed (updated_at bump only) so it is not re-walked every tick", async () => {
    const spy = install({
      sets: [
        {
          data: [
            {
              id: "empty-set", external_id: SET_UUID, name: "Empty",
              set_id_onchain: 9, cover_art_url: "keep", asset_path_prefix: "keep", updated_at: null,
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([gqlRoute("SearchEditionBackfill", tsPage([], null))])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token"),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, sets_processed: 1, editions_upserted: 0, sets_with_cover_set: 0 })
    // Only the updated_at bump — no cover/prefix churn, no editions write.
    const setUpdates = (spy.writes.sets ?? []).filter((w) => w.method === "update")
    expect(setUpdates).toHaveLength(1)
    expect(Object.keys(setUpdates[0].rows[0])).toEqual(["updated_at"])
    expect(spy.writes.editions ?? []).toHaveLength(0)
  })

  it("?limitSets bounds the walk and reports limit_sets_reached with a resume hint", async () => {
    install({
      sets: [
        {
          data: ["s1", "s2"].map((id) => ({
            id, external_id: SET_UUID, name: id,
            set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
          })),
          error: null,
        },
        { data: null, error: null },
      ],
      editions: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([gqlRoute("SearchEditionBackfill", tsPage([KD_EDITION], null))])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token&limitSets=1"),
    )
    const body = await res.json()
    expect(body).toMatchObject({
      sets_processed: 1,
      terminated_reason: "limit_sets_reached",
      last_set_id: "s1",
      resume_hint: "?startAfter=s1",
    })
  })

  it("degrades honestly on an editions upsert failure: ok=false, error sampled, run row records it", async () => {
    const spy = install({
      sets: [
        {
          data: [
            {
              id: "s1", external_id: SET_UUID, name: "S",
              set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      editions: { data: null, error: { message: "editions boom" } },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([gqlRoute("SearchEditionBackfill", tsPage([KD_EDITION], null))])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token"),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: false, editions_upserted: 0, errors_count: 1 })
    expect(body.errors_sample).toEqual([{ set_id: "s1", reason: "editions boom" }])
    const runRow = (spy.writes.pipeline_runs ?? []).find((w) => w.method === "insert")!.rows[0]
    expect(runRow).toMatchObject({ ok: false, error: "editions boom" })
  })

  it("stale_thumbnails mode preserves the RPC's most-broken-first ordering over the unordered .in() read", async () => {
    const spy = install({
      "rpc:topshot_sets_with_stale_thumbnails": { data: [{ set_id: "s2" }, { set_id: "s1" }], error: null },
      sets: [
        {
          // Read comes back in the "wrong" order — the route must re-order to s2-first.
          data: ["s1", "s2"].map((id) => ({
            id, external_id: SET_UUID, name: id,
            set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
          })),
          error: null,
        },
        { data: null, error: null },
      ],
      editions: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([gqlRoute("SearchEditionBackfill", tsPage([KD_EDITION], null))])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token&forceRefresh=stale_thumbnails&limitSets=1"),
    )
    const body = await res.json()
    expect(body).toMatchObject({ mode: "stale_thumbnails", sets_processed: 1, last_set_id: "s2" })
    // The one walked set was s2 (RPC order), not s1 (read order).
    const upserts = (spy.writes.editions ?? []).filter((w) => w.method === "upsert")
    expect(upserts[0].rows[0].set_id).toBe("s2")
  })

  it("stale_thumbnails mode 500s when the ranking RPC fails and short-circuits when nothing is stale", async () => {
    install({ "rpc:topshot_sets_with_stale_thumbnails": { data: null, error: { message: "rpc boom" } } })
    const err = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token&forceRefresh=stale_thumbnails"),
    )
    expect(err.status).toBe(500)
    expect((await err.json()).error).toBe("rpc boom")

    install({ "rpc:topshot_sets_with_stale_thumbnails": { data: [], error: null } })
    const empty = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?token=admin-token&forceRefresh=stale_thumbnails"),
    )
    expect(await empty.json()).toMatchObject({
      ok: true, sets_processed: 0, terminated_reason: "no_stale_thumbnails",
    })
  })
})

// ── Pinnacle catalog ─────────────────────────────────────────────────────────

function pinPage(nodes: unknown[], hasNextPage: boolean, endCursor: string | null, totalCount = 2) {
  return {
    data: {
      searchPinnacleEditions: {
        totalCount,
        pageInfo: { endCursor, hasNextPage },
        edges: nodes.map((node) => ({ node })),
      },
    },
  }
}

function floorPage(edges: unknown[], totalCount = 4) {
  return {
    data: {
      searchPinnacleNft: {
        totalCount,
        pageInfo: { endCursor: null, hasNextPage: false },
        edges,
      },
    },
  }
}

const MICKEY_NODE = {
  id: 991,
  render_id: "rid-1",
  variant: "Standard",
  printing: "3",
  total_minted: "2000",
  chaser: false,
  parallel_type: null,
  edition_type: { name: "Open Edition", limited_edition: false },
  series: { name: "Series 1" },
  set: { name: "Starter Set", render_id: "set-rid" },
  shape: {
    name: "Mickey Mouse",
    render_id: "shape-rid",
    metadata: { royalty_codes: ["MCK01", "MCK-ALT"], characters: "Mickey Mouse", franchises: ["Disney"] },
  },
  metadata: { color: "Red", effects: null, materials: "Plastic", size: "Standard", thickness: null },
}
const NULL_RENDER_NODE = { ...MICKEY_NODE, id: 992, render_id: null }

describe("/api/admin/backfill-pinnacle-catalog", () => {
  it("accepts all three token families and fails closed otherwise", async () => {
    fetchMock = installFetchMock([
      gqlRoute("CatalogBackfill", pinPage([], false, null, 0)),
      gqlRoute("FloorAsks", floorPage([])),
    ])
    for (const auth of ["Bearer admin-token", "Bearer ingest-secret", "Bearer cron-secret"]) {
      state.afterCbs.length = 0
      const res = await pinCatalog.GET(
        adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: auth }),
      )
      expect(res.status).toBe(202)
      expect(await res.json()).toMatchObject({
        ok: true, accepted: true, pipeline: "pinnacle-catalog-backfill", floors_only: false,
      })
      await runDeferred() // drain so the next iteration starts clean
    }
    expect((await pinCatalog.POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog"))).status).toBe(401)
  })

  it("pages the catalog, upserts render_id-keyed rows with the composed legacy key, then sweeps floors first-seen-wins", async () => {
    const spy = install({
      pinnacle_catalog: { data: null, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    fetchMock = installFetchMock([
      gqlRoute("CatalogBackfill", [
        pinPage([MICKEY_NODE], true, "page-2"),
        pinPage([NULL_RENDER_NODE, { ...MICKEY_NODE, id: 993, render_id: "rid-2" }], false, null),
      ]),
      gqlRoute("FloorAsks", floorPage([
        { node: { edition: { render_id: "rid-1" }, listing: { price: "12.5" } } },
        { node: { edition: { render_id: "rid-1" }, listing: { price: "99" } } }, // dupe — first wins
        { node: { edition: { render_id: "rid-2" }, listing: { price: "0" } } }, // non-positive — dropped
        { node: { edition: { render_id: "rid-3" }, listing: { price: "abc" } } }, // NaN — dropped
      ])),
    ])

    const res = await pinCatalog.POST(
      adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(202)
    await runDeferred()

    // Page 1 + page 2 upserts; the null-render node was dropped.
    const upserts = (spy.writes.pinnacle_catalog ?? []).filter((w) => w.method === "upsert")
    expect(upserts).toHaveLength(2)
    expect(upserts[0].rows[0]).toMatchObject({
      render_id: "rid-1",
      edition_id: "991",
      character_name: "Mickey Mouse",
      set_name: "Starter Set",
      variant: "Standard",
      printing: 3, // parsed int, not the GQL string
      total_minted: 2000,
      royalty_code: "MCK01", // first royalty code
      royalty_codes: ["MCK01", "MCK-ALT"],
      characters: ["Mickey Mouse"], // scalar string normalized to array
      legacy_edition_key: "MCK01:Standard:3",
      thumbnail_url: "/api/public/pinnacle-image/rid-1",
      front_anim_url: "https://assets.disneypinnacle.com/render/rid-1/front_anim.webp",
      source: "studio-platform-gql",
    })
    expect(upserts[1].rows.map((r) => r.render_id)).toEqual(["rid-2"])

    // Floor sweep: first-seen (price-asc) wins; junk prices dropped.
    const floorCall = spy.rpcCalls.find((c) => c.name === "pinnacle_catalog_set_floor_asks")!
    expect(floorCall.args?.p_map).toEqual({ "rid-1": 12.5 })

    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log).toMatchObject({
      p_pipeline: "pinnacle-catalog-backfill",
      p_rows_found: 2, // GQL totalCount
      p_rows_written: 2, // catalog upserts (not floor rows) in full mode
      p_ok: true,
      p_error: null,
      p_collection_slug: "disney_pinnacle",
    })
    expect(log.p_extra).toMatchObject({
      floors_only: false, pages: 2, upserted: 2, floor_listed: 1, floor_rows: 1, floor_pages: 1,
    })
  })

  it("?floors_only=1 skips the catalog pager entirely and reports the floor pipeline identity", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 5, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    fetchMock = installFetchMock([
      gqlRoute("FloorAsks", floorPage([
        { node: { edition: { render_id: "rid-9" }, listing: { price: "3" } } },
      ])),
    ])

    const res = await pinCatalog.GET(
      adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }),
    )
    expect(await res.json()).toMatchObject({ pipeline: "pinnacle-catalog-floor-refresh", floors_only: true })
    await runDeferred()

    // No CatalogBackfill request ever left the handler.
    for (const c of fetchMock.calls) {
      expect(String(c.init?.body)).not.toContain("CatalogBackfill")
    }
    expect(spy.writes.pinnacle_catalog ?? []).toHaveLength(0)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log).toMatchObject({ p_pipeline: "pinnacle-catalog-floor-refresh", p_rows_written: 5, p_ok: true })
  })

  it("a catalog GQL failure is recorded but the floor sweep still runs (best-effort phases)", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    const catalogDown: FetchStub = {
      match: (_url, init) => String(init?.body ?? "").includes("CatalogBackfill"),
      respond: () => ({ status: 500 }),
    }
    fetchMock = installFetchMock([
      catalogDown,
      gqlRoute("FloorAsks", floorPage([
        { node: { edition: { render_id: "rid-1" }, listing: { price: "7" } } },
      ])),
    ])

    await pinCatalog.POST(
      adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }),
    )
    await runDeferred()

    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log).toMatchObject({ p_pipeline: "pinnacle-catalog-backfill", p_ok: false, p_error: "GQL 500" })
    // Floor phase completed despite the catalog failure.
    expect(log.p_extra).toMatchObject({ upserted: 0, floor_listed: 1, floor_rows: 1 })
    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_catalog_set_floor_asks")).toBe(true)
  })
})
