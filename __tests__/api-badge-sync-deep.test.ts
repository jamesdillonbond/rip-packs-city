import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  jsonRoute,
} from "./helpers/route-harness"

// Deep-drive of /api/badge-sync — the 4x/day GHA badge sweep whose structural
// blind spots caused the badge coverage-gap saga. Drives both modes with a
// scripted searchMarketplaceEditions feed and pins:
//   - canonical int-pair keying via the authoritative sets-table bridge
//     (set.flowId is unreliable; a UUID/0-sentinel key must never land);
//   - parallels of one play MERGE into a single row with union badges
//     (the (external_id, collection_id) grain);
//   - badge_score / three-star-rookie / rookie-mint derivation;
//   - the re-key-safe write path (delete stale rows by parallel id, then
//     upsert on the int-pair key);
//   - catalog mode's cursor persistence + completion wrap + pipeline_runs row.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  // Keyed by the first play-tag id / setplay-tag id; "catalog" for the
  // untagged full-catalog query. Value = pages consumed in order.
  gqlPages: {} as Record<string, unknown[]>,
  gqlCursor: {} as Record<string, number>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: Record<string, unknown>) => {
    const playTags = (vars.byPlayTagIDs as string[] | undefined) ?? []
    const setPlayTags = (vars.bySetPlayTagIDs as string[] | undefined) ?? []
    const key = playTags[0] ?? setPlayTags[0] ?? "catalog"
    const pages = state.gqlPages[key] ?? []
    const i = state.gqlCursor[key] ?? 0
    state.gqlCursor[key] = i + 1
    const page = pages[Math.min(i, Math.max(pages.length - 1, 0))] ?? gqlPage([], null)
    const poison = (page as { __throw?: string }).__throw
    if (poison) throw new Error(poison)
    return page
  },
}))

const { POST, GET } = await import("@/app/api/badge-sync/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const RY = "2dbd4eef-4417-451b-b645-90f02574a401" // Rookie Year
const RP = "0ddb2c58-4385-443b-9c70-239b32cddbd4" // Rookie Premiere
const TSD = "a75e247a-ecbf-45a6-b1be-58bb07a1b651" // Top Shot Debut
const ROTY = "34fe8d3f-681a-42df-856a-e98624f95b11"
const RM = "24d515af-e967-45f5-a30e-11fc96dc2b62" // Rookie Mint (setplay)
const CHAMP = "f197f60a-b502-4386-b0c0-7f4cde8164ff"

function gqlPage(editions: unknown[], rightCursor: string | null) {
  return {
    searchMarketplaceEditions: {
      data: {
        searchSummary: {
          pagination: { rightCursor },
          data: { size: editions.length, data: editions },
        },
      },
    },
  }
}

function edition(opts: {
  id: string
  playTagIds?: string[]
  setPlayTagIds?: string[]
  parallelID?: number
  parallelName?: string
  setUuid?: string
  playFlowID?: string | null
}) {
  return {
    id: opts.id,
    assetPathPrefix: null,
    tier: "COMMON",
    parallelID: opts.parallelID ?? 0,
    parallelName: opts.parallelName ?? "Standard",
    set: { id: opts.setUuid ?? "set-uuid-1", flowId: null, flowName: "Base Set", flowSeriesNumber: 5 },
    play: {
      id: "play-uuid-1",
      flowID: opts.playFlowID === undefined ? "45" : opts.playFlowID,
      stats: {
        playerName: "Scoot Henderson",
        firstName: "Scoot",
        lastName: "Henderson",
        teamAtMoment: "Portland Trail Blazers",
        teamAtMomentNbaId: "1610612757",
        nbaSeason: "2023-24",
        jerseyNumber: "00",
        playerID: "player-ext-9",
        playCategory: "Assist",
        dateOfMoment: "2026-01-15T00:00:00Z",
      },
      tags: (opts.playTagIds ?? []).map((id) => ({ id, title: `tag-${id.slice(0, 4)}`, visible: true, level: "play" })),
    },
    setPlay: {
      ID: "sp-uuid-1",
      flowRetired: false,
      tags: (opts.setPlayTagIds ?? []).map((id) => ({ id, title: `sptag-${id.slice(0, 4)}`, visible: true, level: "setplay" })),
      circulations: {
        burned: 10, circulationCount: 4000, forSaleByCollectors: 50,
        hiddenInPacks: 5, ownedByCollectors: 3000, locked: 600, effectiveSupply: 3990,
      },
    },
    lowAsk: 3.5,
    highestOffer: 2.1,
    averageSaleData: { averagePrice: "4.25" },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture({
    sets: { data: [{ external_id: "set-uuid-1", set_id_onchain: 3 }], error: null },
    badge_editions: { data: null, error: null, count: 2 } as never,
    pipeline_runs: { data: null, error: null },
    backfill_state: { data: null, error: null },
    ...fixtures,
  })
  state.sb = spy.fixture
  return spy
}

function post(qs = ""): NextRequest {
  return new NextRequest(`https://t/api/badge-sync${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer badge-token" }),
  })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "badge-token"
  state.gqlPages = {}
  state.gqlCursor = {}
  fetchMock = installFetchMock([jsonRoute("/api/seed-golazos-badges", { seeded: true })])
})

describe("badge-sync — tag sweep mode", () => {
  it("merges parallels of one play into a single int-pair row with union badges and the re-key-safe write", async () => {
    // Rookie Year sweep sees the Standard printing; TS Debut sweep sees a
    // parallel of the SAME play carrying a different badge.
    state.gqlPages[RY] = [gqlPage([edition({ id: "e1", playTagIds: [RY] })], null)]
    state.gqlPages[TSD] = [
      gqlPage([edition({ id: "e1-par", playTagIds: [TSD], parallelID: 19, parallelName: "Hexwave" })], null),
    ]
    const spy = install({})

    const res = await POST(post())
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({
      ok: true,
      collected: 1, // ONE row per play, not per parallel
      upserted: 1,
      skippedNoKey: 0,
      deletedStaleRows: 2, // both parallel ids freed before the keyed upsert
    })
    expect(body.sweepCounts).toMatchObject({ "Rookie Year": 1, "Top Shot Debut": 1, ROTY: 0 })

    const upsert = spy.writes.badge_editions?.find((w) => w.method === "upsert")
    const row = upsert?.rows[0] as Record<string, unknown>
    // Keyed via the sets-table bridge (set.flowId was NULL in the feed).
    expect(row.external_id).toBe("3:45")
    expect(row.collection_id).toBe(TOPSHOT)
    // Union of both parallels' badges on the single row.
    const tagIds = (row.play_tags as Array<{ id: string }>).map((t) => t.id).sort()
    expect(tagIds).toEqual([RY, TSD].sort())
    expect(row.is_three_star_rookie).toBe(false)
    expect(row.badge_score).toBe(2) // RY (1) + TSD (1)
    expect(row.player_name).toBe("Scoot Henderson")
    expect(row.circulation_count).toBe(4000)
    // Golazos seed endpoint was pinged (AllDay deliberately NOT re-seeded here).
    expect(body.seedResults["seed-golazos-badges"]).toMatchObject({ seeded: true })
    expect(fetchMock!.calls.some((c) => c.url.includes("seed-allday"))).toBe(false)
  })

  // 🚨 THE TAG SWEEP WROTE NO pipeline_runs ROW AT ALL until 2026-08-29, while its
  // CATALOG sibling always did. So "is badge-sync running?" returned rows for the
  // catalog walk and nothing for the six-hourly lane that maintains
  // `badge_editions.low_ask` — and I nearly read that absence as "it is dead"
  // when it only meant UNOBSERVABLE. What IS measurable is the output: on
  // 2026-08-29 All Day's `badge_editions` asks had a median age of 0.4 h (it has a
  // dedicated `allday-badge-low-ask-refresh`), while Top Shot's were **107.2 h**
  // with all 1,651 ask-bearing rows over 12 h and no Top Shot equivalent of that
  // refresher. `badge_editions` is the FALLBACK ask for readers the offers sweep
  // has not reached, so watchlist / badges / set-plan serve Top Shot asks a median
  // 4.5 days old. The row does not fix that; it makes the lane answerable.
  it("writes a durable pipeline_runs row for the TAG sweep, not just the catalog walk", async () => {
    state.gqlPages[RY] = [gqlPage([edition({ id: "e1", playTagIds: [RY] })], null)]
    const spy = install({})

    await POST(post())

    const runs = (spy.writes.pipeline_runs ?? []).flatMap((w) => w.rows) as Record<string, unknown>[]
    const row = runs.find((r) => r.pipeline === "topshot-badge-sync")
    expect(row, "the tag sweep logged no pipeline_runs row — its health is unobservable").toBeTruthy()
    expect(row!.ok).toBe(true)
    expect(row!.rows_found).toBe(1)
    expect(row!.rows_written).toBe(1)
    expect(row!.collection_slug).toBe("nba_top_shot")
    expect((row!.extra as Record<string, unknown>).upsert_errors).toBe(0)
  })

  it("a sweep whose upserts ALL failed is not reported as ok", async () => {
    state.gqlPages[RY] = [gqlPage([edition({ id: "e1", playTagIds: [RY] })], null)]
    // Upsert path errors; the delete path stays clean so the sweep still reaches its tail.
    const spy = install({ badge_editions: { data: null, error: { message: "upsert boom" }, count: 0 } as never })

    const res = await POST(post())
    const body = await res.json()

    // `ok` in the RESPONSE was hardcoded true regardless of upsert outcome.
    expect(body.ok, "the response asserted success over a sweep that wrote nothing").toBe(false)

    const runs = (spy.writes.pipeline_runs ?? []).flatMap((w) => w.rows) as Record<string, unknown>[]
    const row = runs.find((r) => r.pipeline === "topshot-badge-sync")
    expect(row!.ok).toBe(false)
    expect(row!.error).toMatch(/upsert_errors/)
  })

  it("CONTROL — an EMPTY sweep stays ok (nothing collected is not a failure)", async () => {
    // No pages configured ⇒ every tag sweep returns zero editions.
    const spy = install({})

    const res = await POST(post())
    const body = await res.json()
    expect(body.ok, "a sweep with nothing to do must not redden").toBe(true)
    expect(body.collected).toBe(0)

    const runs = (spy.writes.pipeline_runs ?? []).flatMap((w) => w.rows) as Record<string, unknown>[]
    const row = runs.find((r) => r.pipeline === "topshot-badge-sync")
    expect(row!.ok).toBe(true)
    expect(row!.rows_found).toBe(0)
  })

  it("derives three-star rookie + rookie-mint scoring, and drops editions that cannot form an int-pair key", async () => {
    state.gqlPages[RY] = [
      gqlPage(
        [
          edition({ id: "e2", playTagIds: [RY, RP, TSD], setPlayTagIds: [RM] }),
          // Unknown set UUID + null play flowID -> no canonical key -> skipped.
          edition({ id: "e3", playTagIds: [RY], setUuid: "set-uuid-unknown", playFlowID: null }),
        ],
        null,
      ),
    ]
    const spy = install({})

    const body = await (await POST(post())).json()
    expect(body.collected).toBe(1)
    expect(body.skippedNoKey).toBe(1)

    const row = spy.writes.badge_editions?.find((w) => w.method === "upsert")?.rows[0] as Record<string, unknown>
    expect(row.is_three_star_rookie).toBe(true)
    expect(row.has_rookie_mint).toBe(true)
    // RY+RP+TSD (3) + RM (1) + three-star-with-mint bonus (4) = 8.
    expect(row.badge_score).toBe(8)
  })
})

describe("badge-sync — catalog mode", () => {
  it("walks the catalog, persists the wrapped cursor on completion, and logs the pipeline row", async () => {
    state.gqlPages.catalog = [
      gqlPage([edition({ id: "e1", playTagIds: [ROTY] })], null), // short page -> feed exhausted
    ]
    const spy = install({})

    const res = await POST(post("?mode=catalog"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      ok: true,
      mode: "catalog",
      pagesFetched: 1,
      nodesFetched: 1,
      distinctEditions: 1,
      upserted: 1,
      sweepComplete: true,
      terminatedReason: "feed_exhausted",
      cursorAfter: null, // wrapped to "" (serialized null) so the next run restarts
    })

    // Cursor state persisted as complete + wrapped.
    const cursorUpsert = spy.writes.backfill_state?.find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({
      id: "topshot-badge-catalog",
      cursor: "",
      status: "complete",
    })

    // Observability row.
    const run = (spy.writes.pipeline_runs ?? [])
      .flatMap((w) => w.rows)
      .find((r) => r.pipeline === "topshot-badge-catalog")
    expect(run).toMatchObject({ ok: true, rows_found: 1, rows_written: 1 })
    expect((run?.extra as Record<string, unknown>).sweep_complete).toBe(true)

    const row = spy.writes.badge_editions?.find((w) => w.method === "upsert")?.rows[0] as Record<string, unknown>
    expect(row.external_id).toBe("3:45")
    expect(row.badge_score).toBe(3) // ROTY alone
  })

  it("a GQL failure mid-walk keeps the resume cursor and logs ok=false", async () => {
    state.gqlPages.catalog = [
      gqlPage([edition({ id: "e1" })], "cursor-page-2"),
      { __throw: "upstream 429" }, // page 2 dies mid-walk
    ]
    const spy = install({})
    const body = await (await POST(post("?mode=catalog"))).json()
    expect(body.ok).toBe(false)
    expect(body.terminatedReason).toBe("gql_error")
    // Resume cursor persisted (NOT wrapped) so the next run continues.
    const cursorUpsert = spy.writes.backfill_state?.find((w) => w.method === "upsert")
    expect(cursorUpsert?.rows[0]).toMatchObject({ cursor: "cursor-page-2", status: "pending" })
    const run = (spy.writes.pipeline_runs ?? [])
      .flatMap((w) => w.rows)
      .find((r) => r.pipeline === "topshot-badge-catalog")
    expect(run?.ok).toBe(false)
    expect(String(run?.error)).toContain("upstream 429")
  })
})

describe("badge-sync — guards + GET", () => {
  it("401s without the token", async () => {
    install({})
    const res = await POST(new NextRequest("https://t/api/badge-sync", { method: "POST" }))
    expect(res.status).toBe(401)
  })

  it("GET aggregates badge_editions_counts per collection", async () => {
    install({
      "rpc:badge_editions_counts": {
        data: [
          { collection_id: TOPSHOT, count: 2900 },
          { collection_id: "dee28451-5d62-409e-a1ad-a83f763ac070", count: "1500" },
        ],
        error: null,
      },
    })
    const body = await (await GET()).json()
    expect(body.counts[TOPSHOT]).toBe(2900)
    expect(body.total).toBe(4400)
  })
})
