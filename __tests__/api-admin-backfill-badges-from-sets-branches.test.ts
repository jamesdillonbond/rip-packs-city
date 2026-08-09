import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Branch coverage for the compute core of /api/admin/backfill-badges-from-sets.
// The sibling test only drives the 0-missing dryRun (helpers stay dark). This
// drives the full dryRun pipeline — missing-edition diff, the int→UUID sets
// bridge (36-char UUID gate + reachable/unreachable split), the per-set GQL
// walk, editionKey (set.flowId rung, since setMap is int-keyed here), mergeTags
// on duplicate keys, computeBadgeScore, normalizeEdition, the KD sample, the
// ?set= filter, and the GQL-error break — all with writes suppressed (dryRun).

const reads = vi.hoisted(() => ({
  editions: [] as any[],
  badge_editions: [] as any[],
  sets: [] as any[],
  upsertError: null as any,
}))
const gql = vi.hoisted(() => ({ bySetUuid: {} as Record<string, any> }))

vi.mock("@/lib/supabase", () => {
  function builder(table: string): any {
    const data = () => (reads as any)[table] ?? []
    const b: any = {
      select: () => b,
      order: () => b,
      eq: () => b,
      not: () => b,
      in: () => b,
      range: async () => ({ data: data(), error: null }),
      insert: async () => ({ data: null, error: null }),
      upsert: async () => ({ data: null, error: reads.upsertError }),
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async (_q: string, vars: any) => {
    const uuid = vars?.input?.filters?.bySetIDs?.[0]
    const entry = gql.bySetUuid[uuid]
    if (entry?.__throw) throw new Error(entry.__throw)
    return { searchEditions: { searchSummary: { data: { data: entry?.editions ?? [] } } } }
  },
}))

const { POST } = await import("@/app/api/admin/backfill-badges-from-sets/route")

const RY = "2dbd4eef-4417-451b-b645-90f02574a401"
const RP = "0ddb2c58-4385-443b-9c70-239b32cddbd4"
const TSD = "a75e247a-ecbf-45a6-b1be-58bb07a1b651"
const RM = "24d515af-e967-45f5-a30e-11fc96dc2b62"
const CHAMP = "f197f60a-b502-4386-b0c0-7f4cde8164ff"

// Valid 36-char UUIDs (the fetchSetUuidMap gate requires /^[0-9a-f-]{36}$/).
const SET_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
const SET_KD = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

function gqlEdition(opts: {
  id: string
  setUuid: string
  setFlowId?: string | null
  playId?: string
  playFlowID?: string | null
  playTagIds?: string[]
  setPlayTagIds?: string[]
  player?: string
  circNull?: boolean
  parallelID?: number
}) {
  return {
    id: opts.id,
    tier: "RARE",
    parallelID: opts.parallelID ?? 0,
    parallelName: null,
    set: { id: opts.setUuid, flowId: opts.setFlowId ?? null, flowName: "Trophy Set", flowSeriesNumber: 4 },
    play: {
      id: opts.playId ?? "play-uuid",
      flowID: opts.playFlowID === undefined ? null : opts.playFlowID,
      stats: {
        playerName: opts.player ?? "Player", teamAtMoment: "PDX", teamAtMomentNbaId: "1610612757",
        nbaSeason: "2023-24", playerID: "pid-1",
      },
      tags: (opts.playTagIds ?? []).map((id) => ({ id, title: `t-${id.slice(0, 4)}`, visible: true, level: "play" })),
    },
    setPlay: {
      ID: "sp-1", flowRetired: false,
      tags: (opts.setPlayTagIds ?? []).map((id) => ({ id, title: `s-${id.slice(0, 4)}`, visible: true, level: "setplay" })),
      circulations: opts.circNull
        ? null
        : { burned: 5, circulationCount: 100, forSaleByCollectors: 2, hiddenInPacks: 1, ownedByCollectors: 80, locked: 10, effectiveSupply: 95 },
    },
    circulationCount: 100,
  }
}

function req(qs = ""): NextRequest {
  return new NextRequest(`https://t/api/admin/backfill-badges-from-sets${qs}`, {
    method: "POST",
    headers: new Headers({ authorization: "Bearer ingest" }),
  })
}

beforeEach(() => {
  process.env.INGEST_SECRET_TOKEN = "ingest"
  reads.editions = []
  reads.badge_editions = []
  reads.sets = []
  reads.upsertError = null
  gql.bySetUuid = {}
})
afterEach(() => {
  delete process.env.INGEST_SECRET_TOKEN
})

describe("backfill-badges-from-sets — compute pipeline (dryRun)", () => {
  it("computes a badge row for a missing edition via the sets bridge + set.flowId rung", async () => {
    reads.editions = [{ external_id: "3:45", set_id_onchain: 3 }]
    reads.badge_editions = [] // nothing has a badge row ⇒ 3:45 is missing
    reads.sets = [{ external_id: SET_A, set_id_onchain: 3 }]
    gql.bySetUuid[SET_A] = {
      editions: [gqlEdition({ id: "e1", setUuid: SET_A, setFlowId: "3", playFlowID: "45", playTagIds: [RY, RP, TSD], setPlayTagIds: [RM] })],
    }

    const body = await (await POST(req("?dryRun=1"))).json()
    expect(body.ok).toBe(true)
    expect(body.dryRun).toBe(true)
    expect(body.totalMissing).toBe(1)
    expect(body.reachableSets).toBe(1)
    expect(body.computedRows).toBe(1)
    expect(body.sampleRows[0]).toMatchObject({ external_id: "3:45", badge_score: 8 }) // RY+RP+TSD+RM + three-star bonus
  })

  it("populates the KD sample when the 165:6563 trophy edition is computed", async () => {
    reads.editions = [{ external_id: "165:6563", set_id_onchain: 165 }]
    reads.sets = [{ external_id: SET_KD, set_id_onchain: 165 }]
    gql.bySetUuid[SET_KD] = {
      editions: [gqlEdition({ id: "kd", setUuid: SET_KD, setFlowId: "165", playFlowID: "6563", player: "Kevin Durant", playTagIds: [CHAMP] })],
    }

    const body = await (await POST(req("?dryRun=1"))).json()
    expect(body.kdSample).not.toBeNull()
    expect(body.kdSample).toMatchObject({ external_id: "165:6563", player_name: "Kevin Durant", badge_score: 2 })
  })

  it("reports a set with no recoverable UUID as unreachableNoSetUuid", async () => {
    reads.editions = [{ external_id: "999:1", set_id_onchain: 999 }]
    reads.sets = [] // 999 has no bridge row and no sibling badge_editions.set_id
    const body = await (await POST(req("?dryRun=1"))).json()
    expect(body.totalMissing).toBe(1)
    expect(body.reachableSets).toBe(0)
    expect(body.unreachableNoSetUuidSets).toBe(1)
    expect(body.unreachableNoSetUuidSetIds).toContain("999")
    expect(body.computedRows).toBe(0)
  })

  it("restricts the walk to a single on-chain set via ?set=", async () => {
    reads.editions = [
      { external_id: "3:45", set_id_onchain: 3 },
      { external_id: "165:6563", set_id_onchain: 165 },
    ]
    reads.sets = [
      { external_id: SET_A, set_id_onchain: 3 },
      { external_id: SET_KD, set_id_onchain: 165 },
    ]
    gql.bySetUuid[SET_A] = { editions: [gqlEdition({ id: "e1", setUuid: SET_A, setFlowId: "3", playFlowID: "45", playTagIds: [RY] })] }
    gql.bySetUuid[SET_KD] = { editions: [gqlEdition({ id: "kd", setUuid: SET_KD, setFlowId: "165", playFlowID: "6563", playTagIds: [CHAMP] })] }

    const body = await (await POST(req("?dryRun=1&set=3"))).json()
    expect(body.onlySet).toBe("3")
    expect(body.setsQueried).toBe(1) // only set 3 walked
    expect(body.computedRows).toBe(1)
    expect(body.sampleRows[0].external_id).toBe("3:45")
  })

  it("merges duplicate keys within a set (parallels) and skips editions not in the missing set", async () => {
    reads.editions = [{ external_id: "3:45", set_id_onchain: 3 }]
    reads.sets = [{ external_id: SET_A, set_id_onchain: 3 }]
    gql.bySetUuid[SET_A] = {
      editions: [
        gqlEdition({ id: "base", setUuid: SET_A, setFlowId: "3", playFlowID: "45", playTagIds: [RY] }),
        // Same 3:45 key (a parallel) carrying a different badge ⇒ mergeTags.
        gqlEdition({ id: "par", setUuid: SET_A, setFlowId: "3", playFlowID: "45", playTagIds: [TSD], parallelID: 19 }),
        // A different, non-missing key ⇒ skipped.
        gqlEdition({ id: "other", setUuid: SET_A, setFlowId: "3", playFlowID: "999", playTagIds: [RY] }),
        // No integer pair ⇒ editionKey null ⇒ skipped.
        gqlEdition({ id: "nokey", setUuid: SET_A, setFlowId: null, playFlowID: null }),
      ],
    }

    const body = await (await POST(req("?dryRun=1"))).json()
    expect(body.computedRows).toBe(1) // merged into one row
    const tags = body.sampleRows[0].play_tags.sort()
    expect(tags).toEqual([`t-${RY.slice(0, 4)}`, `t-${TSD.slice(0, 4)}`].sort())
  })

  it("surfaces a GQL error and stops with ok:false", async () => {
    reads.editions = [{ external_id: "3:45", set_id_onchain: 3 }]
    reads.sets = [{ external_id: SET_A, set_id_onchain: 3 }]
    gql.bySetUuid[SET_A] = { __throw: "searchEditions 400: bad field" }

    const body = await (await POST(req("?dryRun=1"))).json()
    expect(body.ok).toBe(false)
    expect(body.gqlError).toContain("searchEditions 400")
    expect(body.computedRows).toBe(0)
  })
})

describe("backfill-badges-from-sets — write path (non-dryRun)", () => {
  it("upserts the computed rows and logs a pipeline_runs row on success", async () => {
    reads.editions = [{ external_id: "3:45", set_id_onchain: 3 }]
    reads.sets = [{ external_id: SET_A, set_id_onchain: 3 }]
    gql.bySetUuid[SET_A] = { editions: [gqlEdition({ id: "e1", setUuid: SET_A, setFlowId: "3", playFlowID: "45", playTagIds: [RY] })] }

    const body = await (await POST(req())).json() // no dryRun
    expect(body.dryRun).toBe(false)
    expect(body.ok).toBe(true)
    expect(body.upserted).toBe(1)
    expect(body.upsertErrors).toBe(0)
  })

  it("counts an upsert failure and reports ok:false", async () => {
    reads.editions = [{ external_id: "3:45", set_id_onchain: 3 }]
    reads.sets = [{ external_id: SET_A, set_id_onchain: 3 }]
    reads.upsertError = { message: "badge_editions_pkey conflict" }
    gql.bySetUuid[SET_A] = { editions: [gqlEdition({ id: "e1", setUuid: SET_A, setFlowId: "3", playFlowID: "45", playTagIds: [RY] })] }

    const body = await (await POST(req())).json()
    expect(body.ok).toBe(false)
    expect(body.upserted).toBe(0)
    expect(body.upsertErrors).toBe(1)
  })
})

describe("backfill-badges-from-sets — auth guard", () => {
  it("401s without a valid bearer", async () => {
    const res = await POST(new NextRequest("https://t/api/admin/backfill-badges-from-sets?dryRun=1", { method: "POST" }))
    expect(res.status).toBe(401)
  })
})
