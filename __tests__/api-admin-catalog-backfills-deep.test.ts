import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  gqlRoute,
} from "./helpers/route-harness"
import { adminReq } from "./helpers/admin-req"

// Deep-loop tests for the two catalog walkers:
//
//   /api/admin/backfill-topshot-catalog   (RPC_ADMIN_TOKEN ONLY — synchronous
//     set-by-set GQL walk that upserts `editions` keyed on the int-pair
//     external_id and stamps the parent `sets` row)
//   /api/admin/backfill-pinnacle-catalog  (RPC_ADMIN or INGEST or CRON —
//     202+after() Atlas pager (through the DB, since 2026-11-18) that upserts
//     `pinnacle_catalog` keyed on the edition render_id, then floors + live listings)
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

// The Pinnacle route reaches Atlas through dbAtlasDisneyCall(db) (pg_net). Only that
// factory is swapped — every parser and sweep in the module runs for real.
const atlasState = vi.hoisted(() => ({
  handler: null as null | ((method: string, body: Record<string, unknown>) => unknown),
  calls: [] as Array<{ method: string; body: Record<string, unknown> }>,
}))
vi.mock("@/lib/pinnacle/atlas-disney", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pinnacle/atlas-disney")>()
  return {
    ...actual,
    dbAtlasDisneyCall: () => async (method: string, body: Record<string, unknown>) => {
      atlasState.calls.push({ method, body })
      return atlasState.handler ? atlasState.handler(method, body) : { ok: false, status: null, error: "no atlas fixture" }
    },
  }
})

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
  atlasState.handler = null
  atlasState.calls.length = 0
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

// The GQL query MUST select `description` on `Play`, not on `Play.stats` —
// `PlayStats` has no such field and asking for it 422s the whole page. This
// fixture puts the prose at the correct depth and a decoy at the wrong one, so
// a regression that reads stats.description writes the decoy (or null) instead.
const DESCRIBED_EDITION = {
  tier: "MOMENT_TIER_LEGENDARY",
  circulationCount: 99,
  assetPathPrefix: "https://assets.nbatopshot.com/editions/165_x/uuid/play_uuid_capture_",
  set: { flowId: 165, flowName: "MVP Moments", flowSeriesNumber: 5 },
  play: {
    flowID: "7001",
    description: "  Damian Lillard  pulls up\nfrom the logo   as time expires.  ",
    stats: {
      playerName: "Damian Lillard",
      teamAtMoment: "Portland Trail Blazers",
      playCategory: "Jump Shot",
      playType: "3 Pointer",
      dateOfMoment: "2026-02-01T03:00:00Z",
      // Decoy at the WRONG depth — must never reach editions.description.
      description: "WRONG-DEPTH-SENTINEL",
    },
  },
}

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
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
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
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
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
      adminReq("https://t/api/admin/backfill-topshot-catalog?limitSets=1", { authorization: "Bearer admin-token" }),
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
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
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
      adminReq("https://t/api/admin/backfill-topshot-catalog?forceRefresh=stale_thumbnails&limitSets=1", { authorization: "Bearer admin-token" }),
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
      adminReq("https://t/api/admin/backfill-topshot-catalog?forceRefresh=stale_thumbnails", { authorization: "Bearer admin-token" }),
    )
    expect(err.status).toBe(500)
    expect((await err.json()).error).toBe("rpc boom")

    install({ "rpc:topshot_sets_with_stale_thumbnails": { data: [], error: null } })
    const empty = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?forceRefresh=stale_thumbnails", { authorization: "Bearer admin-token" }),
    )
    expect(await empty.json()).toMatchObject({
      ok: true, sets_processed: 0, terminated_reason: "no_stale_thumbnails",
    })
  })

  it("normalizes every tier vocab and builds/omits CDN URLs off assetPathPrefix", async () => {
    // One set, one GQL page carrying editions that exercise every normalizeTier
    // rung, the null-prefix (no URL) case, an already-.mp4 prefix (video passthru),
    // a player-only name, a non-numeric set id, and a malformed game date.
    const mk = (over: Record<string, unknown>) => ({
      tier: null,
      circulationCount: 1,
      assetPathPrefix: "https://cdn/pfx_",
      set: { flowId: 1, flowName: "S", flowSeriesNumber: 3 },
      play: { flowID: "10", stats: { playerName: "P", dateOfMoment: "2026-01-15T00:00:00Z" } },
      ...over,
    })
    const editions = [
      mk({ tier: "MOMENT_TIER_ULTIMATE", play: { flowID: "1", stats: { playerName: "U" } } }),
      mk({ tier: "MOMENT_TIER_LEGENDARY", play: { flowID: "2", stats: { playerName: "L" } } }),
      mk({ tier: "MOMENT_TIER_FANDOM", play: { flowID: "3", stats: { playerName: "F" } } }),
      mk({ tier: "MOMENT_TIER_COMMON", play: { flowID: "4", stats: { playerName: "C" } } }),
      mk({ tier: "MOMENT_TIER_ANOMALY", play: { flowID: "5", stats: { playerName: "X" } } }), // unknown → null
      mk({ tier: null, play: { flowID: "6", stats: { playerName: "N" } } }), // null tier → null
      // null prefix → thumbnail + video both null
      mk({ assetPathPrefix: null, play: { flowID: "7", stats: { playerName: "Z" } } }),
      // prefix already ends .mp4 → video passthrough, thumbnail still appends Hero
      mk({ assetPathPrefix: "https://cdn/clip.mp4", play: { flowID: "8", stats: { playerName: "M" } } }),
      // player-only (no set name) → name is the player, set_name null
      mk({ set: { flowId: 1, flowName: null }, play: { flowID: "9", stats: { playerName: "Solo" } } }),
      // non-numeric set id → set_id_onchain null, external_id keeps the raw pair
      mk({ set: { flowId: "abc", flowName: "S" }, play: { flowID: "20", stats: { playerName: "Q" } } }),
      // malformed date → game_date null
      mk({ play: { flowID: "21", stats: { playerName: "D", dateOfMoment: "not-a-date" } } }),
    ]
    const spy = install({
      sets: [
        {
          data: [
            {
              id: "set-row-1", external_id: SET_UUID, name: "S",
              set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      editions: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([gqlRoute("SearchEditionBackfill", tsPage(editions, null))])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(200)
    const rows = (spy.writes.editions ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows)
    const by = (playId: string) => rows.find((r) => r.external_id === `1:${playId}` || r.external_id === `abc:${playId}`)
    expect(by("1")!.tier).toBe("ULTIMATE")
    expect(by("2")!.tier).toBe("LEGENDARY")
    expect(by("3")!.tier).toBe("FANDOM")
    expect(by("4")!.tier).toBe("COMMON")
    expect(by("5")!.tier).toBeNull() // unknown vocab
    expect(by("6")!.tier).toBeNull() // null tier
    expect(by("7")).toMatchObject({ thumbnail_url: null, video_url: null }) // null prefix
    expect(by("8")).toMatchObject({
      video_url: "https://cdn/clip.mp4", // already .mp4 → passthrough
      thumbnail_url: "https://cdn/clip.mp4Hero_2880_2880_Transparent.png",
    })
    expect(by("9")).toMatchObject({ name: "Solo", set_name: null }) // player-only name
    const nonNumeric = rows.find((r) => r.external_id === "abc:20")!
    expect(nonNumeric).toMatchObject({ set_id_onchain: null }) // non-finite → null
    expect(by("21")!.game_date).toBeNull() // malformed date
  })

  it("breaks the set walk on a GQL page HTTP error, an errors-array response, and a thrown fetch — each set marked processed", async () => {
    const spy = install({
      sets: [
        {
          data: ["s1", "s2", "s3"].map((id) => ({
            id, external_id: SET_UUID, name: id,
            set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
          })),
          error: null,
        },
        { data: null, error: null },
      ],
      pipeline_runs: { data: null, error: null },
    })
    let call = 0
    fetchMock = installFetchMock([
      {
        match: (_url, init) => String(init?.body ?? "").includes("SearchEditionBackfill"),
        respond: () => {
          call++
          if (call === 1) return { status: 500 } // !res.ok → fetchEditionsPage null
          if (call === 2) return { json: { errors: [{ message: "gql err" }] } } // errors array → null
          throw new Error("network down") // thrown fetch → catch → null
        },
      },
    ])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
    )
    const body = await res.json()
    // All three sets FAULTED. This used to assert ok:true — a test pinning the
    // exact silent-success that let the 2026-08-11 malformed-query outage run a
    // full day reporting sets_processed=257 / editions_upserted=0 /
    // errors_count=0. Every set faulting is unambiguous and must be loud.
    expect(body).toMatchObject({
      ok: false,
      sets_processed: 3,
      sets_faulted: 3,
      editions_upserted: 0,
      gql_calls: 3,
      errors_count: 3,
    })
    // The fault REASON is what makes the next outage diagnosable in one look:
    // for a malformed query the upstream body names the offending field.
    const reasons = (body.errors_sample as Array<{ reason: string }>).map((e) => e.reason)
    expect(reasons[0]).toMatch(/HTTP 500/)
    expect(reasons[1]).toMatch(/gql: gql err/)
    expect(reasons[2]).toMatch(/network down/)
    // Sets are still stamped, so a persistently-broken set cannot pin itself at
    // the head of the least-recently-touched queue and starve everything behind.
    expect((spy.writes.editions ?? [])).toHaveLength(0)
    expect((spy.writes.sets ?? []).filter((w) => w.method === "update")).toHaveLength(3)
  })

  it("reads the play description from Play, not Play.stats, and normalizes it", async () => {
    const spy = install({
      sets: [
        {
          data: [{
            id: "s1", external_id: SET_UUID, name: "MVP Moments",
            set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
          }],
          error: null,
        },
        { data: null, error: null },
      ],
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([
      {
        match: (_url, init) => String(init?.body ?? "").includes("SearchEditionBackfill"),
        respond: () => ({ json: tsPage([DESCRIBED_EDITION], null) }),
      },
    ])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(200)

    // The query itself must ask at the right depth. Selecting `description`
    // inside `stats { … }` is the 2026-08-11 outage: PlayStats has no such
    // field, so the upstream 422s every page and nothing is ever written.
    const sent = String(fetchMock.calls[0]?.init?.body ?? "")
    // Slice to the stats block's own closing brace — a fixed-width window is
    // long enough to look right and short enough to assert nothing.
    const statsStart = sent.indexOf("stats {")
    expect(statsStart).toBeGreaterThan(-1)
    const statsBlock = sent.slice(statsStart, sent.indexOf("}", statsStart))
    expect(statsBlock).not.toContain("description")
    expect(sent).toMatch(/flowID\\n\s*description/)

    const rows = (spy.writes.editions ?? []).flatMap((w) => w.rows as any[])
    const row = rows.find((r) => r.external_id === "165:7001")!
    // Whitespace collapsed for trigram consistency; decoy never reached it.
    expect(row.description).toBe("Damian Lillard pulls up from the logo as time expires.")
    expect(row.description).not.toContain("WRONG-DEPTH-SENTINEL")
  })

  it("a genuinely EMPTY set is not a fault — walk stays ok with sets_faulted 0", async () => {
    // The other half of the distinction the fault type exists to draw: a set
    // that really holds no editions answers HTTP 200 with an empty data array.
    // That is a RESULT, not a failure to obtain one, so it must not redden the
    // run — otherwise the fix trades a silent failure for a crying-wolf one.
    const spy = install({
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
      pipeline_runs: { data: null, error: null },
    })
    fetchMock = installFetchMock([
      {
        match: (_url, init) => String(init?.body ?? "").includes("SearchEditionBackfill"),
        respond: () => ({ json: tsPage([], null) }),
      },
    ])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      sets_processed: 2,
      sets_faulted: 0,
      editions_upserted: 0,
      errors_count: 0,
    })
    expect((spy.writes.editions ?? [])).toHaveLength(0)
  })

  it("500s when the natural-mode sets read errors", async () => {
    install({ sets: { data: null, error: { message: "sets boom" } } })
    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sets boom")
  })

  it("stale_thumbnails mode 500s when the .in() sets read errors after the ranking RPC", async () => {
    install({
      "rpc:topshot_sets_with_stale_thumbnails": { data: [{ set_id: "s1" }], error: null },
      sets: { data: null, error: { message: "in boom" } },
    })
    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog?forceRefresh=stale_thumbnails", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("in boom")
  })

  it("?startAfter resumes the natural sweep by slicing past the named set", async () => {
    install({
      sets: [
        {
          data: ["s1", "s2", "s3"].map((id) => ({
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
      adminReq("https://t/api/admin/backfill-topshot-catalog?startAfter=s1&limitSets=1", { authorization: "Bearer admin-token" }),
    )
    const body = await res.json()
    // s1 sliced out → the first walked set is s2.
    expect(body).toMatchObject({ sets_processed: 1, last_set_id: "s2", terminated_reason: "limit_sets_reached" })
  })

  it("halts the page walk when the GQL cursor cycles (runaway-loop guard)", async () => {
    install({
      sets: [
        {
          data: [
            {
              id: "cyc", external_id: SET_UUID, name: "Cyc",
              set_id_onchain: null, cover_art_url: null, asset_path_prefix: null, updated_at: null,
            },
          ],
          error: null,
        },
        { data: null, error: null },
      ],
      editions: { data: null, error: null },
      pipeline_runs: { data: null, error: null },
    })
    // Cursor sequence B → A → B: on the 4th iteration "B" is a seen cursor → break.
    fetchMock = installFetchMock([
      gqlRoute("SearchEditionBackfill", [
        tsPage([KD_EDITION], "B"),
        tsPage([KD_EDITION], "A"),
        tsPage([KD_EDITION], "B"),
      ]),
    ])

    const res = await tsCatalog.GET(
      adminReq("https://t/api/admin/backfill-topshot-catalog", { authorization: "Bearer admin-token" }),
    )
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, sets_processed: 1, gql_calls: 3 })
  })
})

// ── Pinnacle catalog (Atlas, 2026-11-18 — #218) ──────────────────────────────
//
// The route reads Dapper's Atlas through the DATABASE (lib/pinnacle/atlas-disney.ts,
// dbAtlasDisneyCall). Here that one factory is replaced by an in-memory Atlas that
// pages the fixtures exactly as the live API does (limit/offset, pagination.hasMore);
// every parser and sweep in that module runs for real.

type AtlasReply = { ok: true; body: unknown } | { ok: false; status: number | null; error: string }

const MICKEY = {
  id: "991",
  renderId: "rid-1",
  parallel: "Standard",
  printing: "3",
  numMinted: "2000",
  chaser: false,
  lowAskCents: "1250",
  series: { name: "Series 1" },
  set: { id: "7", name: "Starter Set", renderId: "set-rid" },
  editionTemplate: {
    name: "Mickey Mouse",
    renderId: "shape-rid",
    editionType: "Open Edition",
    // Atlas sends list metadata either JSON-encoded or comma-joined — both shapes here.
    metadata: { RoyaltyCodes: '["MCK01","MCK-ALT"]', Characters: "Mickey Mouse", Franchises: "Disney,Pixar" },
  },
  metadata: { Color: "Red", Materials: "Plastic", Size: "Standard" },
}
const NO_RENDER = { ...MICKEY, id: "992", renderId: "" }
const ed = (id: string, renderId: string, lowAskCents = "0") => ({ ...MICKEY, id, renderId, lowAskCents })

function atlasMarket(o: {
  editions: unknown[]
  listings?: unknown[]
  failEditionsAt?: number
  failListingsAt?: number
  endlessListings?: boolean
}) {
  return (method: string, body: Record<string, unknown>): AtlasReply => {
    const limit = Number(body.limit)
    const offset = Number(body.offset)
    if (method === "EditionService/SearchEditions") {
      if (o.failEditionsAt === offset) return { ok: false, status: 403, error: "<!DOCTYPE html><title>Just a moment...</title>" }
      const page = o.editions.slice(offset, offset + limit)
      return {
        ok: true,
        body: { editions: page, pagination: { totalCount: String(o.editions.length), limit: String(limit), offset: String(offset), hasMore: offset + limit < o.editions.length } },
      }
    }
    if (method === "MarketplaceService/SearchMarketplaceTransactions") {
      if (o.failListingsAt === offset) return { ok: false, status: 403, error: "<!DOCTYPE html><title>Just a moment...</title>" }
      if (o.endlessListings) {
        const rows = Array.from({ length: limit }, (_, i) => ({ uuid: `u-${offset + i}`, nftId: String(5000 + offset + i), editionId: "991", priceCents: "300", serialNumber: "0", completed: false }))
        return { ok: true, body: { transactions: rows, pagination: { totalCount: "999999", hasMore: true } } }
      }
      const all = o.listings ?? []
      const page = all.slice(offset, offset + limit)
      return { ok: true, body: { transactions: page, pagination: { totalCount: String(all.length), hasMore: offset + limit < all.length } } }
    }
    return { ok: false, status: 404, error: `unexpected method ${method}` }
  }
}

// `pinnacle_catalog` reads are the limited_edition counts (true, then false) per edition type.
const OPEN_EDITION_IS_NOT_LIMITED = [
  { data: null, error: null, count: 0 },
  { data: null, error: null, count: 5 },
]

describe("/api/admin/backfill-pinnacle-catalog (Atlas)", () => {
  it("accepts all three token families and fails closed otherwise", async () => {
    atlasState.handler = atlasMarket({ editions: [] })
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

  it("pages SearchEditions, upserts EDITION-renderId-keyed rows with the composed legacy key, and floors from lowAskCents", async () => {
    const spy = install({
      pinnacle_catalog: OPEN_EDITION_IS_NOT_LIMITED,
      "pinnacle_catalog:upsert": { data: null, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    // 101 editions → two pages at the server's 100 cap.
    const fillers = Array.from({ length: 99 }, (_, i) => ed(String(2000 + i), `fill-${i}`))
    atlasState.handler = atlasMarket({ editions: [MICKEY, NO_RENDER, ...fillers] })

    const res = await pinCatalog.POST(
      adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }),
    )
    expect(res.status).toBe(202)
    await runDeferred()

    const editionCalls = atlasState.calls.filter((c) => c.method === "EditionService/SearchEditions")
    expect(editionCalls.map((c) => c.body.offset)).toEqual([0, 100])
    expect(editionCalls.every((c) => c.body.product === "disney" && c.body.limit === 100)).toBe(true)

    const upserts = (spy.writes.pinnacle_catalog ?? []).filter((w) => w.method === "upsert")
    expect(upserts).toHaveLength(1)
    expect(upserts[0].options).toMatchObject({ onConflict: "render_id" })
    const rows = upserts[0].rows
    expect(rows).toHaveLength(100) // the render-less edition is never keyed
    expect(rows.find((r) => r.edition_id === "992")).toBeUndefined()
    expect(rows[0]).toEqual({
      render_id: "rid-1", // the EDITION's renderId — never set.renderId (set-level)
      edition_id: "991",
      shape_render_id: "shape-rid",
      character_name: "Mickey Mouse",
      set_name: "Starter Set",
      set_render_id: "set-rid",
      variant: "Standard", // Atlas `parallel`
      parallel_type: null,
      printing: 3, // parsed int, not the API string
      total_minted: 2000,
      edition_type: "Open Edition",
      limited_edition: false, // as the catalog already records "Open Edition"
      series_name: "Series 1",
      royalty_code: "MCK01", // first royalty code
      royalty_codes: ["MCK01", "MCK-ALT"],
      franchises: ["Disney", "Pixar"], // comma-joined form split
      characters: ["Mickey Mouse"], // scalar normalized to array
      color: "Red",
      effects: null,
      materials: '["Plastic"]',
      size: "Standard",
      thickness: null,
      is_chaser: false,
      legacy_edition_key: "MCK01:Standard:3",
      thumbnail_url: "/api/public/pinnacle-image/rid-1",
      front_anim_url: "https://assets.disneypinnacle.com/render/rid-1/front_anim.webp",
      source: "atlas-edition-search",
      updated_at: expect.any(String),
    })

    // Floors: only renders with a positive lowAskCents; raw UFix64 units (cents × 1e6).
    const floorCall = spy.rpcCalls.find((c) => c.name === "pinnacle_catalog_set_floor_asks")!
    expect(floorCall.args?.p_map).toEqual({ "rid-1": 1_250_000_000 })

    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log).toMatchObject({
      p_pipeline: "pinnacle-catalog-backfill",
      p_rows_found: 101, // Atlas totalCount
      p_rows_written: 100, // catalog upserts (not floor rows) in full mode
      p_ok: true,
      p_error: null,
      p_collection_slug: "disney_pinnacle",
    })
    expect(log.p_extra).toMatchObject({
      source: "atlas", floors_only: false, pages: 2, editions_complete: true, upserted: 100, unkeyed: 1, floor_listed: 1, floor_rows: 1,
    })
  })

  // 2026-09-27 — the sweep KEEPS every live listing (pinnacle_live_listings) so the Sniper
  // reads live asks. The live set may only be REPLACED from a COMPLETE sweep.
  it("a COMPLETE listing sweep replaces the live listing set with every usable listing, in DOLLARS", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 2, error: null },
      "rpc:pinnacle_live_listings_replace": { data: { written: 3, deleted: 7 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({
      editions: [ed("991", "rid-1", "1250"), ed("993", "rid-2", "400")],
      listings: [
        { uuid: "a", nftId: "101", editionId: "991", priceCents: "1250", serialNumber: "7", completed: false },
        { uuid: "b", nftId: "102", editionId: "991", priceCents: "2000", serialNumber: "0", completed: false }, // serial 0 = open edition
        { uuid: "c", nftId: "103", editionId: "993", priceCents: "400", completed: false },
        { uuid: "c", nftId: "103", editionId: "993", priceCents: "400", completed: false }, // same uuid again — kept once
        { uuid: "d", nftId: "104", editionId: "993", priceCents: "0", completed: false }, // non-positive — dropped
        { uuid: "e", nftId: "105", editionId: "993", priceCents: "100", completed: true }, // a SALE, not a listing — dropped
      ],
    })
    await pinCatalog.GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }))
    await runDeferred()

    const listingCall = atlasState.calls.find((c) => c.method === "MarketplaceService/SearchMarketplaceTransactions")!
    expect(listingCall.body).toMatchObject({ completed: false, sortByOption: "LISTED_AT", sortByDirection: "ASC", limit: 200, offset: 0 })

    const live = spy.rpcCalls.find((c) => c.name === "pinnacle_live_listings_replace")!
    expect(live.args?.p_rows).toEqual([
      { nft_id: "101", render_id: "rid-1", serial_number: 7, price_usd: 12.5 },
      { nft_id: "102", render_id: "rid-1", serial_number: null, price_usd: 20 },
      { nft_id: "103", render_id: "rid-2", serial_number: null, price_usd: 4 },
    ])
    expect(typeof live.args?.p_seen_at).toBe("string")
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(true)
    expect(log.p_extra).toMatchObject({
      floor_complete: true, live_listings_seen: 3, live_duplicates: 1, live_written: 3, live_deleted: 7, floor_agrees_with_listings: 2,
    })
  })

  it("⚠ a listing page Cloudflare challenged leaves the live set alone and says so (status in the error)", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:pinnacle_live_listings_replace": { data: { written: 1, deleted: 0 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({
      editions: [ed("991", "rid-1", "300")],
      listings: Array.from({ length: 900 }, (_, i) => ({ uuid: `u${i}`, nftId: String(i + 1), editionId: "991", priceCents: "300", completed: false })),
      failListingsAt: 400,
    })
    await pinCatalog.GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }))
    await runDeferred()

    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_live_listings_replace")).toBe(false)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/live listings: offset 400: atlas SearchMarketplaceTransactions HTTP 403 \(Cloudflare challenge\)/)
    expect((log.p_extra as { errors: string[] }).errors.join(" | ")).toMatch(/sweep incomplete/)
    expect(log.p_extra).toMatchObject({ floor_complete: false, live_written: 0 })
  })

  it("an endless listing feed stops at the page guard, incomplete, and leaves the live set alone", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({ editions: [ed("991", "rid-1", "300")], endlessListings: true })
    await pinCatalog.GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }))
    await runDeferred()

    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_live_listings_replace")).toBe(false)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/page guard/)
    expect(log.p_extra).toMatchObject({ floor_complete: false })
  })

  it("⚠ a listing on an edition the edition sweep never returned cannot be named — the live set is left alone", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:pinnacle_live_listings_replace": { data: { written: 1, deleted: 0 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({
      editions: [ed("991", "rid-1", "300")],
      listings: [
        { uuid: "a", nftId: "1", editionId: "991", priceCents: "300", completed: false },
        { uuid: "b", nftId: "2", editionId: "4040", priceCents: "300", completed: false },
      ],
    })
    await pinCatalog.GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }))
    await runDeferred()
    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_live_listings_replace")).toBe(false)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/1 listing\(s\) on editions the edition sweep did not return/)
    expect(log.p_extra).toMatchObject({ live_unmapped: 1 })
  })

  it("?floors_only=1 skips the catalog upsert entirely and reports the floor pipeline identity", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 5, error: null },
      "rpc:pinnacle_live_listings_replace": { data: { written: 1, deleted: 0 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({
      editions: [ed("991", "rid-9", "300")],
      listings: [{ uuid: "a", nftId: "1", editionId: "991", priceCents: "300", completed: false }],
    })

    const res = await pinCatalog.GET(
      adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }),
    )
    expect(await res.json()).toMatchObject({ pipeline: "pinnacle-catalog-floor-refresh", floors_only: true })
    await runDeferred()

    expect(spy.writes.pinnacle_catalog ?? []).toHaveLength(0)
    expect(spy.rpcCalls.find((c) => c.name === "pinnacle_catalog_set_floor_asks")!.args?.p_map).toEqual({ "rid-9": 300_000_000 })
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log).toMatchObject({ p_pipeline: "pinnacle-catalog-floor-refresh", p_rows_written: 5, p_ok: true })
  })

  it("⚠ an INCOMPLETE edition sweep never writes floors (the RPC would NULL every render it did not see)", async () => {
    const spy = install({
      pinnacle_catalog: OPEN_EDITION_IS_NOT_LIMITED,
      "pinnacle_catalog:upsert": { data: null, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:pinnacle_live_listings_replace": { data: { written: 1, deleted: 0 }, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    const many = Array.from({ length: 150 }, (_, i) => ed(String(3000 + i), `r-${i}`, "500"))
    atlasState.handler = atlasMarket({
      editions: many,
      failEditionsAt: 100,
      listings: [{ uuid: "a", nftId: "1", editionId: "3000", priceCents: "500", completed: false }],
    })
    await pinCatalog.POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }))
    await runDeferred()

    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_catalog_set_floor_asks")).toBe(false)
    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_live_listings_replace")).toBe(false)
    // The page that DID answer is still written — an upsert is per-row truth, add-only.
    const upserts = (spy.writes.pinnacle_catalog ?? []).filter((w) => w.method === "upsert")
    expect(upserts.flatMap((u) => u.rows)).toHaveLength(100)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/editions: offset 100: atlas SearchEditions HTTP 403 \(Cloudflare challenge\)/)
    expect((log.p_extra as { errors: string[] }).errors.join(" | ")).toMatch(/floors: edition sweep incomplete/)
    expect(log.p_extra).toMatchObject({ editions_complete: false, floor_rows: 0 })
  })

  it("⚠ a complete sweep whose editions carry NO lowAskCents is unrenderable — floors are not erased", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 0, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({ editions: [ed("991", "rid-1", "0"), ed("992", "rid-2", "0")], listings: [] })
    await pinCatalog.GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }))
    await runDeferred()
    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_catalog_set_floor_asks")).toBe(false)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/2 editions carried no lowAskCents/)
  })

  it("⚠ a failed limited_edition count read writes NO catalog rows (it would publish null as the flag)", async () => {
    const spy = install({
      pinnacle_catalog: { data: null, error: { message: "statement timeout" } },
      "pinnacle_catalog:upsert": { data: null, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({ editions: [MICKEY], listings: [] })
    await pinCatalog.POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }))
    await runDeferred()
    expect((spy.writes.pinnacle_catalog ?? []).filter((w) => w.method === "upsert")).toHaveLength(0)
    const log = spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args!
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/catalog upsert skipped: limited_edition lookup for "Open Edition": statement timeout/)
  })

  it("an edition type the catalog holds both ways (or never) writes limited_edition null — unknown, not a guess", async () => {
    const spy = install({
      pinnacle_catalog: [
        { data: null, error: null, count: 3 },
        { data: null, error: null, count: 2 },
      ],
      "pinnacle_catalog:upsert": { data: null, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({ editions: [MICKEY], listings: [] })
    await pinCatalog.POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }))
    await runDeferred()
    const row = (spy.writes.pinnacle_catalog ?? []).find((w) => w.method === "upsert")!.rows[0]
    expect(row.limited_edition).toBeNull()
  })
})

// 2026-11-08 (handoff pinnacle-wmc-render-gap, fix 3): after every FULL sweep the backfill
// compares the catalog with RPC's own mint records. A render minted in the last 14 days with no
// catalog row = the source fell behind → the run fails; an old orphan is reported, not alarmed.
describe("/api/admin/backfill-pinnacle-catalog — catalog vs minted pins", () => {
  async function fullRun(gap: { data: unknown; error: unknown } | undefined) {
    const spy = install({
      pinnacle_catalog: OPEN_EDITION_IS_NOT_LIMITED,
      "pinnacle_catalog:upsert": { data: null, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
      ...(gap ? { "rpc:pinnacle_minted_renders_missing_from_catalog": gap } : {}),
    })
    atlasState.handler = atlasMarket({ editions: [MICKEY], listings: [] })
    await pinCatalog.POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }))
    await runDeferred()
    return { spy, log: spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args! }
  }

  it("⚠ a RECENTLY minted render with no catalog row fails the run and says so", async () => {
    const { log } = await fullRun({
      data: { missing_renders: 3, missing_pins: 40, missing_recent_renders: 2, sample: [{ render_id: "NEW-1", pins: 30 }] },
      error: null,
    })
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/catalog behind mints: 2 render\(s\) minted in the last 14 days/)
    expect(log.p_extra).toMatchObject({ minted_renders_missing: 3, minted_pins_missing: 40, minted_renders_missing_recent: 2 })
  })

  it("an OLD orphan alone is reported in extra without failing the run", async () => {
    const { log } = await fullRun({ data: { missing_renders: 1, missing_pins: 1, missing_recent_renders: 0, sample: [] }, error: null })
    expect(log.p_ok).toBe(true)
    expect(log.p_extra).toMatchObject({ minted_renders_missing: 1, minted_renders_missing_recent: 0, mint_gap_error: null })
  })

  it("⚠ a failed gap check is an error, never a silent 'no gap'", async () => {
    const { log } = await fullRun({ data: null, error: { message: "statement timeout" } })
    expect(log.p_ok).toBe(false)
    expect(String((log.p_extra as Record<string, unknown>).mint_gap_error)).toBe("statement timeout")
  })

  // 2026-11-09: the 11-08 Mugs drop sat outside Dapper's search for a day. A missing render is now
  // read from the Pinnacle contract (JSON-Cadence below = what rest-mainnet returns) and inserted
  // fill-only; the run fails only on what is still missing after that.
  const cdcStr = (v: string | null) => (v == null ? { type: "Optional", value: null } : { type: "String", value: v })
  const cdcStruct = (id: string, fields: Record<string, unknown>) => ({
    type: "Struct",
    value: { id, fields: Object.entries(fields).map(([name, value]) => ({ name, value })) },
  })
  const cdcDict = (o: Record<string, unknown>) => ({
    type: "Dictionary",
    value: Object.entries(o).map(([k, v]) => ({ key: { type: "String", value: k }, value: v })),
  })
  const cdcArr = (xs: string[]) => ({ type: "Array", value: xs.map((x) => ({ type: "String", value: x })) })
  const CHAIN_MUG = {
    type: "Array",
    value: [
      cdcDict({
        edition: cdcStruct("A.edf9df96c92f4595.Pinnacle.Edition", {
          id: { type: "Int", value: "2932" },
          renderID: cdcStr("NEW-1"),
          variant: cdcStr("Standard"),
          printing: { type: "Int", value: "1" },
          numberMinted: { type: "UInt64", value: "347" },
          isChaser: { type: "Bool", value: false },
          traits: cdcDict({ Materials: cdcArr(["SILVER"]), Color: cdcStr("FULL COLOR"), Size: cdcStr("MEDIUM"), Thickness: cdcStr("THIN") }),
        }),
        shape: cdcStruct("A.edf9df96c92f4595.Pinnacle.Shape", {
          renderID: cdcStr("NEW"),
          name: cdcStr("Mickey Mouse"),
          metadata: cdcDict({ RoyaltyCodes: cdcArr(["WDAS-OEV1-WDMG"]), Characters: cdcArr(["Mickey Mouse"]), Franchises: cdcArr(["Mickey & Friends"]) }),
        }),
        set: cdcStruct("A.edf9df96c92f4595.Pinnacle.Set", { renderID: cdcStr("OEV1-WDMG"), name: cdcStr("Walt Disney Mugs Vol.1") }),
        series: cdcStruct("A.edf9df96c92f4595.Pinnacle.Series", { name: cdcStr("2026") }),
        editionType: cdcStruct("A.edf9df96c92f4595.Pinnacle.EditionType", { name: cdcStr("Open Edition"), isLimited: { type: "Bool", value: false } }),
      }),
    ],
  }
  const RECENT_GAP = {
    data: {
      missing_renders: 1,
      missing_pins: 347,
      missing_recent_renders: 1,
      sample: [{ render_id: "NEW-1", pins: 347, first_minted_at: new Date(Date.now() - 86_400_000).toISOString() }],
    },
    error: null,
  }
  async function chainRun(flow: { status?: number; json: unknown }, inserted: unknown) {
    const spy = install({
      pinnacle_catalog: OPEN_EDITION_IS_NOT_LIMITED,
      "pinnacle_catalog:upsert": [{ data: null, error: null }, { data: inserted, error: null }],
      pinnacle_mint_events: { data: { edition_id: 2932 }, error: null },
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
      "rpc:pinnacle_minted_renders_missing_from_catalog": RECENT_GAP,
      "rpc:derive_pinnacle_wmc_from_catalog": { data: 347, error: null },
    })
    atlasState.handler = atlasMarket({ editions: [MICKEY], listings: [] })
    fetchMock = installFetchMock([
      { match: (url) => url.includes("rest-mainnet.onflow.org"), respond: () => ({ status: flow.status ?? 200, json: flow.json }) },
    ])
    await pinCatalog.POST(adminReq("https://t/api/admin/backfill-pinnacle-catalog", { authorization: "Bearer admin-token" }))
    await runDeferred()
    return { spy, log: spy.rpcCalls.find((c) => c.name === "log_pipeline_run")!.args! }
  }

  it("a render the search lacks is read from the chain, inserted fill-only, and the run passes", async () => {
    const b64 = Buffer.from(JSON.stringify(CHAIN_MUG)).toString("base64")
    const { spy, log } = await chainRun({ json: b64 }, [{ render_id: "NEW-1" }])
    expect(log.p_ok).toBe(true)
    expect(log.p_extra).toMatchObject({ chain_filled: 1, chain_filled_recent: 1, minted_renders_missing_recent: 1, chain_wmc_derived: 347 })
    // The wallet pins are named in the same run (the render-id lane only derives in hours it resolves new ids).
    expect(spy.rpcCalls.some((c) => c.name === "derive_pinnacle_wmc_from_catalog")).toBe(true)
    const chainWrite = spy.writes.pinnacle_catalog!.find((w) => w.rows.some((r) => r.source === "flow-chain"))!
    // Fill-only: an existing (Dapper) row is never overwritten by a chain row.
    expect(chainWrite.options).toMatchObject({ onConflict: "render_id", ignoreDuplicates: true })
    expect(chainWrite.rows).toHaveLength(1)
    expect(chainWrite.rows[0]).toMatchObject({
      render_id: "NEW-1",
      edition_id: "2932",
      character_name: "Mickey Mouse",
      set_name: "Walt Disney Mugs Vol.1",
      set_render_id: "OEV1-WDMG",
      variant: "Standard",
      printing: 1,
      total_minted: 347,
      edition_type: "Open Edition",
      limited_edition: false,
      series_name: "2026",
      materials: '["SILVER"]',
      effects: null,
      legacy_edition_key: "WDAS-OEV1-WDMG:Standard:1",
      source: "flow-chain",
    })
  })

  it("⚠ a failed chain read leaves the gap, and the run still fails naming why", async () => {
    const { spy, log } = await chainRun({ status: 500, json: { message: "boom" } }, null)
    expect(log.p_ok).toBe(false)
    expect(String(log.p_error)).toMatch(/catalog behind mints: 1 render\(s\).*0 filled from chain; chain: flow script HTTP 500/)
    expect(log.p_extra).toMatchObject({ chain_filled: 0, chain_wmc_derived: 0 })
    expect(spy.rpcCalls.some((c) => c.name === "derive_pinnacle_wmc_from_catalog")).toBe(false)
  })

  it("a floors-only refresh does not run the check", async () => {
    const spy = install({
      "rpc:pinnacle_catalog_set_floor_asks": { data: 1, error: null },
      "rpc:log_pipeline_run": { data: null, error: null },
    })
    atlasState.handler = atlasMarket({ editions: [MICKEY], listings: [] })
    await pinCatalog.GET(adminReq("https://t/api/admin/backfill-pinnacle-catalog?floors_only=1", { authorization: "Bearer cron-secret" }))
    await runDeferred()
    expect(spy.rpcCalls.some((c) => c.name === "pinnacle_minted_renders_missing_from_catalog")).toBe(false)
  })
})
