import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  hydrateTopShotEditions,
  hydrateAllDayEditions,
  resetAllDayCache,
  toUpsertRow,
} from "@/lib/editions-hydrate"

// Locks in the 2026-05-09 hydrator fix: every UUID-format TopShot edition
// produced by hydrateTopShotEditions must carry set_id_onchain +
// play_id_onchain pulled from the GQL response, since the UUID external_id
// has no int pair to parse out.
//
// TopShot GQL quirk: set.flowId is lowercase d, play.flowID is uppercase D.
// The hydrator coerces both to int.

const SET_UUID = "11111111-1111-1111-1111-111111111111"
const PLAY_UUID = "22222222-2222-2222-2222-222222222222"
const UUID_EXTERNAL_ID = `${SET_UUID}:${PLAY_UUID}`
const INT_EXTERNAL_ID = "73:2785"

function fakeGqlResponse(opts: {
  setFlowId: number | string
  playFlowID: string
  playerName?: string
  setName?: string
}) {
  return {
    ok: true,
    json: async () => ({
      data: {
        searchEditions: {
          searchSummary: {
            data: {
              data: [
                {
                  tier: "COMMON",
                  circulationCount: 12345,
                  set: {
                    flowId: opts.setFlowId,
                    flowName: opts.setName ?? "Base Set",
                    flowSeriesNumber: 4,
                  },
                  play: {
                    flowID: opts.playFlowID,
                    stats: {
                      playerName: opts.playerName ?? "Test Player",
                      teamAtMoment: "POR",
                      teamAtMomentNbaId: "1610612757",
                      playCategory: "Dunk",
                      playType: "2 Pointer",
                      dateOfMoment: "2024-12-25T20:00:00Z",
                      homeTeamName: "POR",
                      awayTeamName: "GSW",
                    },
                  },
                },
              ],
            },
          },
        },
      },
    }),
  }
}

describe("hydrateTopShotEditions — on-chain id population", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeGqlResponse({ setFlowId: 73, playFlowID: "2785" })
      )
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("UUID-format external_id populates set_id_onchain and play_id_onchain from GQL response", async () => {
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    expect(row.external_id).toBe(UUID_EXTERNAL_ID)
    expect(row.set_id_onchain).toBe(73)
    expect(row.play_id_onchain).toBe(2785)
    expect(row.ok).toBe(true)
  })

  it("UUID-format insert survives toUpsertRow → both columns retained for upsert", async () => {
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    const clean = toUpsertRow(row)
    expect(clean.set_id_onchain).toBe(73)
    expect(clean.play_id_onchain).toBe(2785)
    expect("ok" in clean).toBe(false)
    expect("redirect" in clean).toBe(false)
  })

  it("int-pair external_id keeps the parsed values (regression: don't overwrite on the merge)", async () => {
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.set_id_onchain).toBe(73)
    expect(row.play_id_onchain).toBe(2785)
  })

  it("GQL returns string flowId — coerces to int, not preserved as string", async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fakeGqlResponse({ setFlowId: "99", playFlowID: "1234" })
      )
    )
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    expect(row.set_id_onchain).toBe(99)
    expect(row.play_id_onchain).toBe(1234)
    expect(typeof row.set_id_onchain).toBe("number")
    expect(typeof row.play_id_onchain).toBe("number")
  })

  it("GQL fault returns null meta → on-chain ids absent for UUID input (no fabrication)", async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            searchEditions: { searchSummary: { data: { data: [] } } },
          },
        }),
      }))
    )
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    const clean = toUpsertRow(row)
    expect(clean.set_id_onchain).toBeUndefined()
    expect(clean.play_id_onchain).toBeUndefined()
    expect(row.ok).toBe(false)
  })

  it("GQL fetch throws → tsGql swallows, UUID row comes back empty (ok false)", async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("gql network error")
      }),
    )
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    expect(row.player_name).toBeNull()
    expect(row.ok).toBe(false)
  })

  it("unrecognized GQL tier normalizes to null", async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const r = fakeGqlResponse({ setFlowId: 73, playFlowID: "2785" })
        const orig = r.json
        r.json = async () => {
          const j = await orig()
          j.data.searchEditions.searchSummary.data.data[0].tier = "MYTHIC"
          return j
        }
        return r
      }),
    )
    const [row] = await hydrateTopShotEditions([UUID_EXTERNAL_ID])
    expect(row.tier).toBeNull()
    expect(row.ok).toBe(true)
  })
})

// ── Guard / malformed-input branch ───────────────────────────────────────────

describe("hydrateTopShotEditions — malformed external_id", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("external_id with no colon → empty skeleton row, no fetch attempted", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const [row] = await hydrateTopShotEditions(["not-a-pair"])
    expect(row.external_id).toBe("not-a-pair")
    expect(row.collection).toBe("nba_top_shot")
    expect(row.player_name).toBeNull()
    expect(row.name).toBeNull()
    expect(row.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("external_id with empty half (\":9\") → empty skeleton row", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const [row] = await hydrateTopShotEditions([":9"])
    expect(row.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("deduplicates + drops falsy external_ids before hydrating", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const rows = await hydrateTopShotEditions(["", "", "bad", "bad"])
    // "" filtered out, "bad" collapsed to one skeleton row
    expect(rows).toHaveLength(1)
    expect(rows[0].external_id).toBe("bad")
  })
})

// ── Cadence int-pair resolver (no supabase → on-chain path) ───────────────────

function cadenceOkResponse(entries: Record<string, string>) {
  const value = Object.entries(entries).map(([k, v]) => ({
    key: { type: "String", value: k },
    value: { type: "String", value: v },
  }))
  const json = JSON.stringify({ type: "Dictionary", value })
  const b64 = Buffer.from(json, "utf8").toString("base64")
  // Flow REST returns the base64 payload wrapped in JSON quotes.
  return { ok: true, text: async () => `"${b64}"` }
}

describe("hydrateTopShotEditions — Cadence int-pair path", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("int-pair with no supabase resolves via Cadence (FullName, set, series, circulation)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        cadenceOkResponse({
          FullName: "LeBron James",
          TeamAtMoment: "LAL",
          PlayCategory: "Dunk",
          PlayType: "2 Pointer",
          DateOfMoment: "2024-12-25T20:00:00Z",
          HomeTeamName: "LAL",
          AwayTeamName: "GSW",
          __SetName: "Base Set",
          __SetSeries: "4",
          __Circulation: "5000",
        }),
      ),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBe("LeBron James")
    expect(row.set_name).toBe("Base Set")
    expect(row.name).toBe("LeBron James — Base Set")
    expect(row.series).toBe(4)
    expect(row.circulation_count).toBe(5000)
    expect(row.team_name).toBe("LAL")
    expect(row.play_type).toBe("2 Pointer")
    expect(row.game_date).toBe("2024-12-25")
    expect(row.home_team).toBe("LAL")
    expect(row.away_team).toBe("GSW")
    // tier is GQL-only; Cadence never carries it
    expect(row.tier).toBeNull()
    expect(row.set_id_onchain).toBe(73)
    expect(row.play_id_onchain).toBe(2785)
    expect(row.ok).toBe(true)
  })

  it("Cadence composes player name from FirstName + LastName when FullName invalid", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        cadenceOkResponse({
          FullName: "<invalid Value>",
          FirstName: "Damian",
          LastName: "Lillard",
          __SetName: "Cosmic",
        }),
      ),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBe("Damian Lillard")
    expect(row.name).toBe("Damian Lillard — Cosmic")
    expect(row.series).toBeNull()
    expect(row.circulation_count).toBeNull()
    expect(row.ok).toBe(true)
  })

  it("Cadence with no name fields → player_name null, ok false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cadenceOkResponse({ __SetName: "Base Set" })),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBeNull()
    expect(row.set_name).toBe("Base Set")
    expect(row.name).toBe("Base Set")
    expect(row.ok).toBe(false)
  })

  it("Cadence empty dict → null meta → empty-ish row (ok false)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cadenceOkResponse({})),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBeNull()
    // on-chain ids still land from the parsed int pair even when meta is null
    expect(row.set_id_onchain).toBe(73)
    expect(row.play_id_onchain).toBe(2785)
    expect(row.ok).toBe(false)
  })

  it("Cadence fetch throw → null meta, ok false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down")
      }),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBeNull()
    expect(row.ok).toBe(false)
  })

  it("Cadence HTTP non-ok → null meta, ok false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 503,
        text: async () => "upstream error",
      })),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBeNull()
    expect(row.ok).toBe(false)
  })

  it("Cadence undecodable body → null meta, ok false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => `"!!!not-base64!!!"` })),
    )
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID])
    expect(row.player_name).toBeNull()
    expect(row.ok).toBe(false)
  })
})

// ── Canonical-sibling redirect (supabase client passed) ───────────────────────

function fakeSupabase(result: { data?: unknown; throws?: boolean }) {
  const builder: Record<string, unknown> = {}
  const chain = () => builder
  builder.select = chain
  builder.eq = chain
  builder.limit = async () => {
    if (result.throws) throw new Error("db unavailable")
    return { data: result.data }
  }
  return { from: () => builder }
}

const SIBLING = {
  id: "sibling-uuid-id",
  external_id: `${SET_UUID}:${PLAY_UUID}`,
  name: "Canonical Name",
  player_name: "Canon Player",
  set_name: "Canon Set",
  team_name: "POR",
  tier: "RARE",
  series: 4,
  circulation_count: 999,
  set_id_onchain: 73,
  play_id_onchain: 2785,
  play_type: "Dunk",
  game_date: "2024-01-01",
  home_team: "POR",
  away_team: "GSW",
}

describe("hydrateTopShotEditions — canonical redirect", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("int-pair with supabase + UUID sibling → redirect row, no GQL/Cadence fetch", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const supabase = fakeSupabase({ data: [SIBLING] })
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID], { supabase })
    expect(row.external_id).toBe(INT_EXTERNAL_ID)
    expect(row.redirect).toEqual({
      canonical_id: "sibling-uuid-id",
      canonical_external_id: `${SET_UUID}:${PLAY_UUID}`,
    })
    expect(row.player_name).toBe("Canon Player")
    expect(row.tier).toBe("RARE")
    expect(row.set_id_onchain).toBe(73)
    expect(row.ok).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("redirect side-channel is stripped by toUpsertRow", async () => {
    const supabase = fakeSupabase({ data: [SIBLING] })
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID], { supabase })
    const clean = toUpsertRow(row)
    expect("redirect" in clean).toBe(false)
    expect("ok" in clean).toBe(false)
    expect(clean.player_name).toBe("Canon Player")
  })

  it("supabase returns only an int-format row (no UUID sibling) → falls through to Cadence", async () => {
    const intRow = { ...SIBLING, external_id: "73:2785" }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        cadenceOkResponse({ FullName: "Cadence Player", __SetName: "Cadence Set" }),
      ),
    )
    const supabase = fakeSupabase({ data: [intRow] })
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID], { supabase })
    expect(row.redirect).toBeUndefined()
    expect(row.player_name).toBe("Cadence Player")
  })

  it("supabase lookup throws → swallowed, falls through to Cadence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cadenceOkResponse({ FullName: "Fallback Player" })),
    )
    const supabase = fakeSupabase({ throws: true })
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID], { supabase })
    expect(row.redirect).toBeUndefined()
    expect(row.player_name).toBe("Fallback Player")
  })

  it("supabase empty result → falls through to Cadence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => cadenceOkResponse({ FullName: "Empty Fallback" })),
    )
    const supabase = fakeSupabase({ data: [] })
    const [row] = await hydrateTopShotEditions([INT_EXTERNAL_ID], { supabase })
    expect(row.redirect).toBeUndefined()
    expect(row.player_name).toBe("Empty Fallback")
  })
})

// ── NFL All Day hydrator ──────────────────────────────────────────────────────

function alldayPage(
  nodes: Array<Record<string, unknown>>,
  opts: { hasNextPage?: boolean; endCursor?: string | null } = {},
) {
  return {
    ok: true,
    json: async () => ({
      data: {
        allEditions: {
          edges: nodes.map((node) => ({ node })),
          pageInfo: {
            hasNextPage: opts.hasNextPage ?? false,
            endCursor: opts.endCursor ?? null,
          },
        },
      },
    }),
  }
}

const ALLDAY_NODE = {
  id: "gql-edition-1",
  circulationCount: 750,
  tier: "LEGENDARY",
  series: { name: "Series 2", number: 2 },
  set: { name: "Base", id: "set1" },
  play: {
    id: "play1",
    playerName: "Patrick Mahomes",
    description: "TD pass",
    team: { name: "KC" },
    classification: "PASS",
    gameDate: "2024-11-01",
    awayTeamName: "DEN",
    homeTeamName: "KC",
  },
}

describe("hydrateAllDayEditions", () => {
  beforeEach(() => {
    resetAllDayCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetAllDayCache()
  })

  it("resolves a composite setId:playId external_id from the relay map", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => alldayPage([ALLDAY_NODE])))
    const [row] = await hydrateAllDayEditions(["set1:play1"])
    expect(row.collection).toBe("nfl_all_day")
    expect(row.player_name).toBe("Patrick Mahomes")
    expect(row.set_name).toBe("Base")
    expect(row.name).toBe("Patrick Mahomes — Base")
    expect(row.team_name).toBe("KC")
    expect(row.tier).toBe("LEGENDARY")
    expect(row.series).toBe(2)
    expect(row.circulation_count).toBe(750)
    expect(row.play_type).toBe("PASS")
    expect(row.game_date).toBe("2024-11-01")
    expect(row.home_team).toBe("KC")
    expect(row.away_team).toBe("DEN")
    expect(row.ok).toBe(true)
  })

  it("indexes editions under the bare gqlId too", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => alldayPage([ALLDAY_NODE])))
    const [row] = await hydrateAllDayEditions(["gql-edition-1"])
    expect(row.external_id).toBe("gql-edition-1")
    expect(row.player_name).toBe("Patrick Mahomes")
    expect(row.ok).toBe(true)
  })

  it("unknown external_id → empty skeleton row", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => alldayPage([ALLDAY_NODE])))
    const [row] = await hydrateAllDayEditions(["does-not-exist"])
    expect(row.player_name).toBeNull()
    expect(row.name).toBeNull()
    expect(row.ok).toBe(false)
    expect(row.collection).toBe("nfl_all_day")
  })

  it("normalizes AllDay tiers and handles null play fields", async () => {
    const node = {
      id: "e2",
      circulationCount: null,
      tier: "COMMON edition",
      series: null,
      set: { name: "Rookies", id: "s2" },
      play: {
        id: "p2",
        playerName: null,
        team: null,
        classification: null,
        gameDate: null,
        awayTeamName: null,
        homeTeamName: null,
      },
    }
    vi.stubGlobal("fetch", vi.fn(async () => alldayPage([node])))
    const [row] = await hydrateAllDayEditions(["s2:p2"])
    expect(row.tier).toBe("COMMON")
    expect(row.player_name).toBeNull()
    expect(row.set_name).toBe("Rookies")
    // name falls back to set_name when player is null
    expect(row.name).toBe("Rookies")
    expect(row.team_name).toBeNull()
    expect(row.series).toBeNull()
    expect(row.ok).toBe(false)
  })

  it("skips null nodes and unrecognized tiers", async () => {
    const node = { ...ALLDAY_NODE, id: "e3", tier: "MYTHICAL", set: { name: "X", id: "s3" }, play: { ...ALLDAY_NODE.play, id: "p3" } }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            allEditions: {
              edges: [{ node: null }, { node }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
      })),
    )
    const [row] = await hydrateAllDayEditions(["s3:p3"])
    expect(row.tier).toBeNull() // MYTHICAL not in the normalize allowlist
    expect(row.player_name).toBe("Patrick Mahomes")
  })

  it("follows pagination across pages via endCursor", async () => {
    const page2Node = {
      ...ALLDAY_NODE,
      id: "gql-edition-2",
      set: { name: "Page2", id: "setA" },
      play: { ...ALLDAY_NODE.play, id: "playA", playerName: "Travis Kelce" },
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alldayPage([ALLDAY_NODE], { hasNextPage: true, endCursor: "cur1" }))
      .mockResolvedValueOnce(alldayPage([page2Node], { hasNextPage: false }))
    vi.stubGlobal("fetch", fetchMock)
    const [row] = await hydrateAllDayEditions(["setA:playA"])
    expect(row.player_name).toBe("Travis Kelce")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("stops paginating when hasNextPage true but endCursor missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(alldayPage([ALLDAY_NODE], { hasNextPage: true, endCursor: null }))
    vi.stubGlobal("fetch", fetchMock)
    const rows = await hydrateAllDayEditions(["gql-edition-1"])
    expect(rows[0].ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("non-ok upstream → empty map → all inputs skeletoned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502 })))
    const [row] = await hydrateAllDayEditions(["set1:play1"])
    expect(row.ok).toBe(false)
    expect(row.player_name).toBeNull()
  })

  it("GraphQL errors array → break → empty map", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ errors: [{ message: "bad query" }] }),
      })),
    )
    const [row] = await hydrateAllDayEditions(["set1:play1"])
    expect(row.ok).toBe(false)
  })

  it("caches the relay pull across calls (fetch runs once)", async () => {
    const fetchMock = vi.fn(async () => alldayPage([ALLDAY_NODE]))
    vi.stubGlobal("fetch", fetchMock)
    await hydrateAllDayEditions(["set1:play1"])
    await hydrateAllDayEditions(["gql-edition-1"])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resetAllDayCache()
    await hydrateAllDayEditions(["set1:play1"])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("proxy env vars add X-Proxy-Secret and swap the URL", async () => {
    const prevUrl = process.env.ALLDAY_PROXY_URL
    const prevSecret = process.env.TS_PROXY_SECRET
    process.env.ALLDAY_PROXY_URL = "https://allday-proxy.example/allday"
    process.env.TS_PROXY_SECRET = "sekret"
    const fetchMock = vi.fn(async () => alldayPage([ALLDAY_NODE]))
    vi.stubGlobal("fetch", fetchMock)
    await hydrateAllDayEditions(["set1:play1"])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://allday-proxy.example/allday")
    expect((init as { headers: Record<string, string> }).headers["X-Proxy-Secret"]).toBe("sekret")
    // restore
    if (prevUrl === undefined) delete process.env.ALLDAY_PROXY_URL
    else process.env.ALLDAY_PROXY_URL = prevUrl
    if (prevSecret === undefined) delete process.env.TS_PROXY_SECRET
    else process.env.TS_PROXY_SECRET = prevSecret
  })
})
