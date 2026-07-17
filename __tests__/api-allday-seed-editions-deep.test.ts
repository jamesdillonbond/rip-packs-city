import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import {
  makeInstrumentedSupabaseFixture,
  installFetchMock,
  type FetchStub,
} from "./helpers/route-harness"

// Deep-drive of POST /api/allday-seed-editions — the AllDay edition bootstrap
// that walks the consumer GQL `allEditions` connection (pagination) and upserts
// editions. Synchronous (no after()). Pinned:
//   - happy seed: paginates hasNextPage/endCursor, builds external_id =
//     `${setId}:${playId}` (fallback gqlId), normalizes tier, maps the row
//     contract exactly, and reports fetched/inserted/tiers/series; a node with
//     no setId/playId/gqlId is dropped;
//   - GQL errors[] and GQL HTTP!=2xx both fatal -> 500 ok:false with the message;
//   - an empty connection returns the "No editions" 200 no-op;
//   - a chunk upsert error falls back to per-row upserts and counts errors;
//   - both fail-closed auth branches (missing token -> 500, wrong token -> 401).

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

process.env.INGEST_SECRET_TOKEN = "seed-token"
const { POST } = await import("@/app/api/allday-seed-editions/route")

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"

function edge(node: Record<string, unknown>) {
  return { node }
}

// A GQL stub that returns each page in `pages` on successive calls (AllDay
// consumer endpoint), so the route's after/endCursor pagination loop runs.
function gqlPages(pages: unknown[]): FetchStub {
  let call = 0
  return {
    match: (url) => url.includes("nflallday.com") || url.includes("allday"),
    respond: () => {
      const p = pages[Math.min(call, pages.length - 1)]
      call++
      return { json: p }
    },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures) {
  const spy = makeInstrumentedSupabaseFixture(fixtures)
  state.sb = spy.fixture
  return spy
}

function req(headers?: Record<string, string>): NextRequest {
  return new NextRequest("https://t/api/allday-seed-editions", {
    method: "POST",
    headers: new Headers(headers ?? { authorization: "Bearer seed-token" }),
  })
}

let fetchMock: ReturnType<typeof installFetchMock> | null = null
afterEach(() => {
  fetchMock?.restore()
  fetchMock = null
})
beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "seed-token"
})

describe("allday-seed-editions — auth", () => {
  it("500s when the server token is unset", async () => {
    delete process.env.INGEST_SECRET_TOKEN
    install({})
    expect((await POST(req())).status).toBe(500)
  })

  it("401s with a wrong token", async () => {
    install({})
    expect((await POST(req({ authorization: "Bearer wrong" }))).status).toBe(401)
  })
})

describe("allday-seed-editions — seed", () => {
  it("paginates + upserts editions with the exact row contract, normalizes tier, drops keyless nodes", async () => {
    fetchMock = installFetchMock([
      gqlPages([
        {
          data: {
            allEditions: {
              edges: [
                edge({
                  id: "gql-1",
                  circulationCount: 500,
                  tier: "legendary",
                  series: { name: "Series 1", number: 1 },
                  set: { name: "Base", id: "set9" },
                  play: {
                    id: "play9",
                    playerName: "Patrick Mahomes",
                    team: { name: "Chiefs" },
                    classification: "Passing TD",
                    gameDate: "2025-11-01",
                    homeTeamName: "Chiefs",
                    awayTeamName: "Broncos",
                  },
                }),
              ],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        },
        {
          data: {
            allEditions: {
              edges: [
                // No set/play -> external_id falls back to gqlId.
                edge({ id: "gql-2", circulationCount: null, tier: "weird-tier", play: {}, set: {} }),
                // No id AND no set/play -> dropped (buildEditionKey null).
                edge({ id: null, tier: "rare", play: {}, set: {} }),
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ]),
    ])
    const spy = install({ editions: { data: null, error: null } })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, fetched: 3, errors: 0 })
    // 2 upsertable rows (keyless node dropped).
    expect(body.inserted).toBe(2)

    const rows = (spy.writes.editions ?? []).flatMap((w) => w.rows)
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.external_id === "set9:play9")).toMatchObject({
      external_id: "set9:play9",
      collection_id: ALLDAY,
      collection: "nfl_all_day",
      player_name: "Patrick Mahomes",
      set_name: "Base",
      team_name: "Chiefs",
      tier: "LEGENDARY",
      series: 1,
      circulation_count: 500,
      play_type: "Passing TD",
      game_date: "2025-11-01",
      home_team: "Chiefs",
      away_team: "Broncos",
    })
    // Fallback external_id = gqlId, unknown tier -> COMMON.
    expect(rows.find((r) => r.external_id === "gql-2")).toMatchObject({ tier: "COMMON", circulation_count: null })

    // tier distribution is over ALL fetched editions (incl. the keyless node,
    // whose tier 'rare' -> RARE still counts) — computed before the key drop.
    expect(body.tiers).toMatchObject({ LEGENDARY: 1, COMMON: 1, RARE: 1 })
    // Two GQL pages fetched.
    expect(fetchMock.calls.filter((c) => c.url.includes("nflallday"))).toHaveLength(2)
  })

  it("an empty connection returns the 'No editions' no-op", async () => {
    fetchMock = installFetchMock([
      gqlPages([{ data: { allEditions: { edges: [], pageInfo: { hasNextPage: false, endCursor: null } } } }]),
    ])
    const spy = install({})
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, message: "No editions returned from GQL", fetched: 0 })
    expect(spy.writes.editions ?? []).toHaveLength(0)
  })

  it("GQL errors[] is fatal -> 500 ok:false", async () => {
    fetchMock = installFetchMock([gqlPages([{ errors: [{ message: "field X not found" }] }])])
    install({})
    const res = await POST(req())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toContain("GQL errors: field X not found")
  })

  it("a GQL HTTP failure is fatal -> 500 ok:false", async () => {
    fetchMock = installFetchMock([
      { match: (url) => url.includes("nflallday"), respond: () => ({ status: 502, ok: false, text: "bad gateway" }) },
    ])
    install({})
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("GQL HTTP 502")
  })

  it("a chunk upsert error falls back to per-row upserts and counts errors", async () => {
    fetchMock = installFetchMock([
      gqlPages([
        {
          data: {
            allEditions: {
              edges: [edge({ id: "gql-x", tier: "rare", set: { id: "s1", name: "S" }, play: { id: "p1" } })],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      ]),
    ])
    // editions upsert returns an error for BOTH the batch and the per-row retry.
    const spy = install({ editions: { error: { message: "constraint boom" } } })

    const res = await POST(req())
    const body = await res.json()
    // batch upsert (1) + per-row retry (1) recorded; row failed both -> errors 1.
    expect((spy.writes.editions ?? []).length).toBe(2)
    expect(body).toMatchObject({ ok: true, fetched: 1, inserted: 0, errors: 1 })
  })
})
