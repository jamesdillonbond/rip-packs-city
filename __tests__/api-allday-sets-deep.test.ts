import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Deep-drive of GET /api/allday-sets — the AllDay set-completion tracker.
// Drives the real Cadence fan-out (owned ids -> metadata -> editions-in-set ->
// edition->play resolution) plus the GQL ask enrichment, and pins the
// completion math the page renders: owned/missing split per play, completion
// percent, total-missing-cost gating (only when every missing piece is
// priced), tier classification, and username resolution.

const state = vi.hoisted(() => ({
  ownedIds: [] as number[],
  metadataById: {} as Record<string, Record<string, string>>,
  editionsBySet: {} as Record<string, number[]>,
  playByEdition: {} as Record<string, { playID: string; tier: string }>,
  playerByPlay: {} as Record<string, string>,
  askBySetPlay: {} as Record<string, number | null>,
  usernameToAddr: {} as Record<string, string>,
}))

vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async (opts: { cadence: string; args?: (arg: unknown, t: unknown) => unknown[] }) => {
      const collected: string[] = []
      opts.args?.(((v: unknown) => {
        collected.push(String(v))
        return v
      }) as never, {} as never)
      const { GET_OWNED_MOMENT_IDS, GET_MOMENT_METADATA, GET_EDITIONS_IN_SET, GET_EDITION_DATA, GET_PLAY_DATA } =
        await import("@/lib/chains/flow/allday-cadence")
      switch (opts.cadence) {
        case GET_OWNED_MOMENT_IDS:
          return state.ownedIds
        case GET_MOMENT_METADATA:
          return state.metadataById[collected[1]] ?? {}
        case GET_EDITIONS_IN_SET:
          return state.editionsBySet[collected[0]] ?? []
        case GET_EDITION_DATA:
          return state.playByEdition[collected[0]] ?? { playID: "", tier: "" }
        case GET_PLAY_DATA:
          return { playerFullName: state.playerByPlay[collected[0]] ?? "Unknown" }
        default:
          throw new Error("unexpected cadence script")
      }
    },
  },
}))

vi.mock("@/lib/chains/flow/allday", () => ({
  alldayGraphql: async (query: string, vars: Record<string, unknown>) => {
    if (query.includes("ResolveUserByUsername")) {
      const addr = state.usernameToAddr[String(vars.username)]
      return { getUserProfileByUsername: addr ? { publicInfo: { flowAddress: addr, username: vars.username } } : null }
    }
    if (query.includes("GetLowestAsk")) {
      const key = `${vars.setId}:${vars.playId}`
      const price = state.askBySetPlay[key]
      return {
        searchMomentListings: {
          data: {
            searchEdge:
              price == null ? [] : [{ node: { moment: { listing: { price } } } }],
          },
        },
      }
    }
    if (query.includes("GetSampleMoment")) {
      return { searchMomentListings: { data: { searchEdge: [] } } }
    }
    // getMintedMoment was removed from the AllDay schema (2026-05-05) — the
    // route treats a null payload as placeholder defaults. Mirror that.
    if (query.includes("GetMoment")) {
      return { getMintedMoment: null }
    }
    throw new Error("unexpected GQL query")
  },
}))

const { GET } = await import("@/app/api/allday-sets/route")

const WALLET = "0xb5053ef95e702657"

function req(qs: string): NextRequest {
  return new NextRequest(`https://t/api/allday-sets${qs}`, { method: "GET" })
}

function meta(player: string, setID: string, playID: string, serial: string): Record<string, string> {
  return { player, setName: "Set Ten", setID, playID, serial, mint: "", tier: "" }
}

beforeEach(() => {
  state.ownedIds = []
  state.metadataById = {}
  state.editionsBySet = {}
  state.playByEdition = {}
  state.playerByPlay = {}
  state.askBySetPlay = {}
  state.usernameToAddr = {}
})

describe("allday-sets — completion math", () => {
  function seedTwoOfThree() {
    state.ownedIds = [1, 2]
    state.metadataById["1"] = meta("Player A", "10", "100", "5")
    state.metadataById["2"] = meta("Player B", "10", "101", "9")
    state.editionsBySet["10"] = [1000, 1001, 1002]
    state.playByEdition["1000"] = { playID: "100", tier: "COMMON" }
    state.playByEdition["1001"] = { playID: "101", tier: "COMMON" }
    state.playByEdition["1002"] = { playID: "102", tier: "COMMON" }
    state.askBySetPlay["10:102"] = 5
  }

  it("splits owned vs missing per play and prices the gap (almost_there at 2/3 with the last piece listed)", async () => {
    seedTwoOfThree()
    const res = await GET(req(`?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({
      wallet: WALLET,
      resolvedAddress: WALLET,
      totalSets: 1,
      completeSets: 0,
    })
    const set = body.sets[0]
    expect(set).toMatchObject({
      setId: "10",
      setName: "Set Ten",
      totalEditions: 3,
      ownedCount: 2,
      missingCount: 1,
      listedCount: 1,
      completionPct: 67,
      totalMissingCost: 5, // every missing piece priced -> summable
      lowestSingleAsk: 5,
      tier: "almost_there",
      asksEnriched: true,
    })
    expect(set.owned.map((o: { playId: string }) => o.playId).sort()).toEqual(["100", "101"])
    expect(set.missing[0]).toMatchObject({ playId: "102", lowestAsk: 5 })
  })

  it("an unpriced gap blocks totalMissingCost and classifies unpriced", async () => {
    seedTwoOfThree()
    state.askBySetPlay["10:102"] = null // nothing listed
    const body = await (await GET(req(`?wallet=${WALLET}`))).json()
    const set = body.sets[0]
<<<<<<< Updated upstream
    // The tier ladder unified into lib/set-completion-tier.ts (2026-08-01):
    // a partially-complete set whose missing piece carries NO live ask has no
    // usable price signal, so it buckets as "unpriced" (not the generic
    // "incomplete"). Mirrors the blessed unit case
    // classifySetTier({ completionPct: 90, missingCount: 1, estimatedCost: null })
    // === "unpriced" in set-completion-tier.test.ts.
=======
    // "unpriced", not "incomplete". Before the 2026-08-01 ladder consolidation
    // (fa1d356) this surface reported "incomplete" for an enriched-but-unpriced
    // gap, while allday-set-progress — one of the five ladders folded into
    // lib/set-completion-tier.ts — reported "unpriced" for the identical state.
    // The unified ladder keeps "unpriced" (see the explicit estimatedCost:null
    // pins in __tests__/set-completion-tier.test.ts), because a set whose gap
    // carries no live ask genuinely has no usable price signal; "incomplete"
    // implied we had priced it and found it merely far away.
    // asksEnriched still distinguishes "ran and found nothing" (true, here)
    // from "never ran" (false, the skipAsks case below), so no information is
    // lost by collapsing both onto the same tier.
>>>>>>> Stashed changes
    expect(set).toMatchObject({
      listedCount: 0,
      totalMissingCost: null,
      lowestSingleAsk: null,
      tier: "unpriced",
<<<<<<< Updated upstream
=======
      asksEnriched: true,
>>>>>>> Stashed changes
    })
  })

  it("skipAsks=1 skips the ask fan-out entirely and reports unpriced honestly", async () => {
    seedTwoOfThree()
    // Poison the ask fixture: if the route fetched asks anyway, listedCount
    // would be 1 and the tier would differ.
    state.askBySetPlay["10:102"] = 999
    const body = await (await GET(req(`?wallet=${WALLET}&skipAsks=1`))).json()
    const set = body.sets[0]
    expect(set).toMatchObject({ listedCount: 0, tier: "unpriced", asksEnriched: false })
  })

  it("a fully-owned set classifies complete and counts toward completeSets", async () => {
    state.ownedIds = [1, 2]
    state.metadataById["1"] = meta("Player A", "10", "100", "5")
    state.metadataById["2"] = meta("Player B", "10", "101", "9")
    state.editionsBySet["10"] = [1000, 1001]
    state.playByEdition["1000"] = { playID: "100", tier: "COMMON" }
    state.playByEdition["1001"] = { playID: "101", tier: "COMMON" }
    const body = await (await GET(req(`?wallet=${WALLET}`))).json()
    expect(body.completeSets).toBe(1)
    expect(body.sets[0]).toMatchObject({ completionPct: 100, tier: "complete", missingCount: 0 })
  })

  it("single-set mode resolves missing-play names from the chain", async () => {
    seedTwoOfThree()
    state.playerByPlay["102"] = "Missing Star"
    const body = await (await GET(req(`?wallet=${WALLET}&set=10`))).json()
    expect(body.sets).toHaveLength(1)
    expect(body.sets[0].missing[0]).toMatchObject({ playId: "102", playerName: "Missing Star" })
  })
})

describe("allday-sets — resolution + guards", () => {
  it("resolves an AllDay username to the Flow address before walking the wallet", async () => {
    state.usernameToAddr["collector99"] = WALLET
    state.ownedIds = []
    const body = await (await GET(req("?wallet=collector99"))).json()
    expect(body).toMatchObject({ wallet: "collector99", resolvedAddress: WALLET, totalSets: 0 })
  })

  it("an unresolvable username surfaces the friendly error (500)", async () => {
    const res = await GET(req("?wallet=nobody-here"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("Could not resolve")
  })

  it("400s without a wallet param; an empty wallet returns the zero-state envelope", async () => {
    expect((await GET(req(""))).status).toBe(400)
    state.ownedIds = []
    const body = await (await GET(req(`?wallet=${WALLET}`))).json()
    expect(body).toMatchObject({ totalSets: 0, completeSets: 0, sets: [] })
  })
})
