import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeInstrumentedSupabaseFixture, installFetchMock, jsonRoute } from "./helpers/route-harness"

// badge-sync — branch coverage for the pure key/score/merge helpers the sibling
// deep test leaves dark: computeBadgeScore's Championship-Year (+2) and ROTY (+3)
// arms, intLike's 0-sentinel / non-integer rejection, editionKey's set.flowId and
// play.id fallback rungs (when the sets-bridge / play.flowID miss), mergeTags'
// rookie-mint-arrives-in-a-later-sweep union, and normalizeEdition's null-
// circulations path. Same mock seams as api-badge-sync-deep.test.ts.

const state = vi.hoisted(() => ({
  sb: null as unknown,
  gqlPages: {} as Record<string, unknown[]>,
  gqlCursor: {} as Record<string, number>,
}))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: Record<string, unknown>) => {
    const playTags = (vars.byPlayTagIDs as string[] | undefined) ?? []
    const setPlayTags = (vars.bySetPlayTagIDs as string[] | undefined) ?? []
    const key = playTags[0] ?? setPlayTags[0] ?? "catalog"
    const pages = state.gqlPages[key] ?? []
    const i = state.gqlCursor[key] ?? 0
    state.gqlCursor[key] = i + 1
    return pages[Math.min(i, Math.max(pages.length - 1, 0))] ?? gqlPage([], null)
  },
}))

const { POST } = await import("@/app/api/badge-sync/route")

const TOPSHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const RY = "2dbd4eef-4417-451b-b645-90f02574a401"
const RP = "0ddb2c58-4385-443b-9c70-239b32cddbd4"
const TSD = "a75e247a-ecbf-45a6-b1be-58bb07a1b651"
const ROTY = "34fe8d3f-681a-42df-856a-e98624f95b11"
const RM = "24d515af-e967-45f5-a30e-11fc96dc2b62"
const CHAMP = "f197f60a-b502-4386-b0c0-7f4cde8164ff"

function gqlPage(editions: unknown[], rightCursor: string | null) {
  return {
    searchMarketplaceEditions: {
      data: { searchSummary: { pagination: { rightCursor }, data: { size: editions.length, data: editions } } },
    },
  }
}

function edition(opts: {
  id: string
  playTagIds?: string[]
  setPlayTagIds?: string[]
  parallelID?: number
  setUuid?: string
  setFlowId?: string | null
  playId?: string
  playFlowID?: string | null
  circulationsNull?: boolean
}) {
  return {
    id: opts.id,
    assetPathPrefix: null,
    tier: "COMMON",
    parallelID: opts.parallelID ?? 0,
    parallelName: "Standard",
    set: { id: opts.setUuid ?? "set-uuid-1", flowId: opts.setFlowId ?? null, flowName: "Base Set", flowSeriesNumber: 5 },
    play: {
      id: opts.playId ?? "play-uuid-1",
      flowID: opts.playFlowID === undefined ? "45" : opts.playFlowID,
      stats: {
        playerName: "Scoot Henderson", firstName: "Scoot", lastName: "Henderson",
        teamAtMoment: "Portland Trail Blazers", teamAtMomentNbaId: "1610612757",
        nbaSeason: "2023-24", jerseyNumber: "00", playerID: "player-ext-9",
        playCategory: "Assist", dateOfMoment: "2026-01-15T00:00:00Z",
      },
      tags: (opts.playTagIds ?? []).map((id) => ({ id, title: `tag-${id.slice(0, 4)}`, visible: true, level: "play" })),
    },
    setPlay: {
      ID: "sp-uuid-1", flowRetired: false,
      tags: (opts.setPlayTagIds ?? []).map((id) => ({ id, title: `sp-${id.slice(0, 4)}`, visible: true, level: "setplay" })),
      circulations: opts.circulationsNull
        ? null
        : { burned: 10, circulationCount: 4000, forSaleByCollectors: 50, hiddenInPacks: 5, ownedByCollectors: 3000, locked: 600, effectiveSupply: 3990 },
    },
    lowAsk: 3.5, highestOffer: 2.1, averageSaleData: { averagePrice: "4.25" },
  }
}

type Fixtures = Parameters<typeof makeInstrumentedSupabaseFixture>[0]
function install(fixtures: Fixtures = {}) {
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

const upsertRows = (spy: ReturnType<typeof install>) =>
  (spy.writes.badge_editions ?? []).filter((w) => w.method === "upsert").flatMap((w) => w.rows) as Array<Record<string, unknown>>

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

describe("badge-sync — computeBadgeScore arms", () => {
  it("scores Championship Year (+2) and ROTY (+3) on distinct plays", async () => {
    state.gqlPages[CHAMP] = [gqlPage([edition({ id: "champ", playTagIds: [CHAMP], playFlowID: "50" })], null)]
    state.gqlPages[ROTY] = [gqlPage([edition({ id: "roty", playTagIds: [ROTY], playFlowID: "51" })], null)]
    const spy = install()

    const body = await (await POST(post())).json()
    expect(body.collected).toBe(2)
    const rows = upsertRows(spy)
    const byKey = Object.fromEntries(rows.map((r) => [r.external_id, r.badge_score]))
    expect(byKey["3:50"]).toBe(2) // CHAMP
    expect(byKey["3:51"]).toBe(3) // ROTY
  })
})

describe("badge-sync — editionKey fallback rungs + intLike", () => {
  it("falls back to set.flowId when the sets-table bridge misses", async () => {
    // set uuid not in the map ⇒ setMap.get(...) null ⇒ intLike(set.flowId="7").
    state.gqlPages[RY] = [
      gqlPage([edition({ id: "fb", playTagIds: [RY], setUuid: "set-uuid-unknown", setFlowId: "7", playFlowID: "60" })], null),
    ]
    const spy = install()
    const body = await (await POST(post())).json()
    expect(body.collected).toBe(1)
    expect(body.skippedNoKey).toBe(0)
    expect(upsertRows(spy)[0].external_id).toBe("7:60")
  })

  it("uses play.id when play.flowID is null but play.id is an integer", async () => {
    state.gqlPages[RY] = [
      gqlPage([edition({ id: "pid", playTagIds: [RY], playFlowID: null, playId: "62" })], null),
    ]
    const spy = install()
    const body = await (await POST(post())).json()
    expect(body.collected).toBe(1)
    expect(upsertRows(spy)[0].external_id).toBe("3:62")
  })

  it("rejects the 0-sentinel and UUID ids as an int-pair key (skippedNoKey)", async () => {
    // sets bridge miss + set.flowId="0" (sentinel) + set.id is a UUID ⇒ no key.
    state.gqlPages[RY] = [
      gqlPage([edition({ id: "zero", playTagIds: [RY], setUuid: "set-uuid-unknown", setFlowId: "0", playFlowID: "63" })], null),
    ]
    const spy = install()
    const body = await (await POST(post())).json()
    expect(body.collected).toBe(0)
    expect(body.skippedNoKey).toBe(1)
    expect(upsertRows(spy).length).toBe(0)
  })
})

describe("badge-sync — mergeTags union across sweeps", () => {
  it("merges a later rookie-mint setplay sweep into an existing play row (three-star + mint)", async () => {
    // Rookie-Year sweep creates the row with the play-level three-star tags…
    state.gqlPages[RY] = [gqlPage([edition({ id: "base", playTagIds: [RY, RP, TSD], playFlowID: "70" })], null)]
    // …the Rookie-Mint setplay sweep sees the SAME play (same 3:70 key) and unions RM in.
    state.gqlPages[RM] = [gqlPage([edition({ id: "base-rm", setPlayTagIds: [RM], playFlowID: "70" })], null)]
    const spy = install()

    const body = await (await POST(post())).json()
    expect(body.collected).toBe(1) // one merged row, not two
    const row = upsertRows(spy)[0]
    expect(row.external_id).toBe("3:70")
    expect(row.has_rookie_mint).toBe(true)
    expect(row.is_three_star_rookie).toBe(true)
    expect(row.badge_score).toBe(8) // RY+RP+TSD (3) + RM (1) + three-star-with-mint (4)
    const pIds = (row.play_tags as Array<{ id: string }>).map((t) => t.id).sort()
    expect(pIds).toEqual([RY, RP, TSD].sort())
  })
})

describe("badge-sync — normalizeEdition null circulations", () => {
  it("treats null circulations as zero counts without throwing", async () => {
    state.gqlPages[RY] = [
      gqlPage([edition({ id: "nocirc", playTagIds: [RY], playFlowID: "80", circulationsNull: true })], null),
    ]
    const spy = install()
    const body = await (await POST(post())).json()
    expect(body.collected).toBe(1)
    const row = upsertRows(spy)[0]
    expect(row.external_id).toBe("3:80")
    expect(row.circulation_count).toBe(0)
    expect(row.burn_rate_pct).toBe(0)
    expect(row.lock_rate_pct).toBe(0)
  })
})
