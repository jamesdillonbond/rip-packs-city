import { describe, it, expect, afterEach, vi } from "vitest"
import {
  BADGE_TAG_IDS,
  THREE_STAR_ROOKIE_TAG_IDS,
  TRAIL_BLAZERS_NBA_ID,
  getBadges,
  isThreeStarRookie,
  hasRookieMint,
  badgeScore,
  burnRate,
  lockRate,
  fetchBadgeEditions,
  fetchBlazersRookieBadgeEditions,
  fetchThreeStarRookies,
} from "@/lib/topshot-badges"
import type { MarketplaceEdition, Tag, Circulations } from "@/lib/topshot-badges"

// Pins the badge scoring + circulation-rate math. These drive the rookie-badge
// sniper ranking and the burn/lock supply signals shown on edition pages, so a
// regression silently re-ranks deals or mis-reports scarcity.

function tag(id: string, title: string, over: Partial<Tag> = {}): Tag {
  return { id, title, visible: over.visible ?? true, level: over.level ?? "PLAY" }
}

function circ(over: Partial<Circulations> = {}): Circulations {
  return {
    burned: 0,
    circulationCount: 0,
    forSaleByCollectors: 0,
    hiddenInPacks: 0,
    ownedByCollectors: 0,
    locked: 0,
    effectiveSupply: 0,
    ownedByCollectorsExcludingListedAndLocked: 0,
    ...over,
  }
}

// Only the fields the pure functions read are populated; cast through unknown.
function edition(opts: {
  playTags?: Tag[]
  setPlayTags?: Tag[] | null
  circulations?: Circulations
}): MarketplaceEdition {
  return {
    play: { tags: opts.playTags ?? [] },
    setPlay: {
      tags: opts.setPlayTags === undefined ? [] : opts.setPlayTags,
      circulations: opts.circulations ?? circ(),
    },
  } as unknown as MarketplaceEdition
}

const ROOKIE_YEAR = () => tag(BADGE_TAG_IDS.ROOKIE_YEAR, "Rookie Year")
const ROOKIE_PREMIERE = () => tag(BADGE_TAG_IDS.ROOKIE_PREMIERE, "Rookie Premiere")
const TOP_SHOT_DEBUT = () => tag(BADGE_TAG_IDS.TOP_SHOT_DEBUT, "Top Shot Debut")
const ROOKIE_MINT = () => tag(BADGE_TAG_IDS.ROOKIE_MINT, "Rookie Mint", { level: "SETPLAY" })
const ROTY = () => tag(BADGE_TAG_IDS.ROOKIE_OF_THE_YEAR, "Rookie of the Year")

describe("getBadges", () => {
  it("merges visible play + setPlay badge titles, de-duplicated", () => {
    const e = edition({
      playTags: [ROOKIE_YEAR(), tag("x", "Top Shot Debut")],
      setPlayTags: [ROOKIE_MINT(), tag("y", "Rookie Year")],
    })
    const badges = getBadges(e)
    expect(badges).toContain("Rookie Year")
    expect(badges).toContain("Rookie Mint")
    // "Rookie Year" appears in both play + setPlay → deduped to one entry
    expect(badges.filter((b) => b === "Rookie Year")).toHaveLength(1)
  })

  it("excludes invisible tags", () => {
    const e = edition({
      playTags: [tag("h", "Interactive", { visible: false })],
    })
    expect(getBadges(e)).toEqual([])
  })

  it("tolerates null setPlay tags", () => {
    const e = edition({ playTags: [ROOKIE_YEAR()], setPlayTags: null })
    expect(getBadges(e)).toEqual(["Rookie Year"])
  })
})

describe("isThreeStarRookie", () => {
  it("true only when all three rookie play tags are present", () => {
    expect(
      isThreeStarRookie(edition({ playTags: [ROOKIE_YEAR(), ROOKIE_PREMIERE(), TOP_SHOT_DEBUT()] }))
    ).toBe(true)
    expect(
      isThreeStarRookie(edition({ playTags: [ROOKIE_YEAR(), ROOKIE_PREMIERE()] }))
    ).toBe(false)
  })
})

describe("hasRookieMint", () => {
  it("detects the setPlay-level Rookie Mint tag", () => {
    expect(hasRookieMint(edition({ setPlayTags: [ROOKIE_MINT()] }))).toBe(true)
    expect(hasRookieMint(edition({ setPlayTags: [] }))).toBe(false)
    expect(hasRookieMint(edition({ setPlayTags: null }))).toBe(false)
  })
})

describe("badgeScore", () => {
  it("scores an unbadged edition at 0", () => {
    expect(badgeScore(edition({}))).toBe(0)
  })

  it("sums individual rookie badges (1 each)", () => {
    expect(badgeScore(edition({ playTags: [ROOKIE_YEAR()] }))).toBe(1)
    expect(
      badgeScore(edition({ playTags: [ROOKIE_YEAR(), ROOKIE_PREMIERE()] }))
    ).toBe(2)
  })

  it("adds the +4 three-star-rookie-with-rookie-mint bonus on top of the base badges", () => {
    // 3 rookie play tags (3) + rookie mint (1) + combo bonus (4) = 8
    const e = edition({
      playTags: [ROOKIE_YEAR(), ROOKIE_PREMIERE(), TOP_SHOT_DEBUT()],
      setPlayTags: [ROOKIE_MINT()],
    })
    expect(badgeScore(e)).toBe(8)
  })

  it("adds +3 for Rookie of the Year", () => {
    expect(badgeScore(edition({ playTags: [ROTY()] }))).toBe(3)
  })
})

describe("burnRate", () => {
  it("returns the burned percentage of circulation", () => {
    expect(burnRate(edition({ circulations: circ({ burned: 25, circulationCount: 100 }) }))).toBe(25)
  })

  it("returns 0 when circulation is 0 (no divide-by-zero)", () => {
    expect(burnRate(edition({ circulations: circ({ burned: 5, circulationCount: 0 }) }))).toBe(0)
  })
})

describe("lockRate", () => {
  it("returns locked as a percentage of owned-by-collectors", () => {
    expect(lockRate(edition({ circulations: circ({ locked: 10, ownedByCollectors: 40 }) }))).toBe(25)
  })

  it("returns 0 when owned is 0", () => {
    expect(lockRate(edition({ circulations: circ({ locked: 3, ownedByCollectors: 0 }) }))).toBe(0)
  })
})

// ── fetchBadgeEditions — client-side filter + normalize over the public-api ───
//
// The Top Shot public-api returns unfiltered editions, so fetchBadgeEditions does
// the badge/parallel/team/season filtering AND the shape normalization (dozens of
// `?? default` fallbacks) here. Mock global fetch to drive the filter arms + the
// non-ok throw + the fallback defaults.

function rawEdition(over: Record<string, any> = {}): any {
  return {
    set: { id: "set1", flowName: "Base", flowSeriesNumber: 4 },
    play: {
      id: "play1",
      flowID: "8121",
      stats: { playerName: "Luka Doncic", teamAtMomentNbaId: "1610612742", nbaSeason: "2024-25" },
      tags: [],
    },
    setPlay: { ID: "sp1", tags: [], circulations: { circulationCount: 100 } },
    parallelID: 0,
    tier: "MOMENT_TIER_RARE",
    stats: { lowestAsk: 12, averagePrice: 9, totalSales: 3 },
    ...over,
  }
}

function stubFetch(rawEditions: any[], ok = true, status = 200) {
  const f = vi.fn(async () => ({
    ok,
    status,
    json: async () => ({ data: { searchEditions: { data: rawEditions } } }),
  }))
  vi.stubGlobal("fetch", f as any)
  return f
}

describe("fetchBadgeEditions", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("throws when the upstream responds non-ok", async () => {
    stubFetch([], false, 503)
    await expect(fetchBadgeEditions({})).rejects.toThrow("Top Shot API error: 503")
  })

  it("normalizes a sparse raw row with fallback defaults", async () => {
    stubFetch([{ play: {}, setPlay: {} }])
    const { editions, nextCursor } = await fetchBadgeEditions({})
    expect(nextCursor).toBeNull()
    expect(editions).toHaveLength(1)
    const e = editions[0]
    expect(e.tier).toBe("MOMENT_TIER_COMMON") // default tier
    expect(e.parallelID).toBe(0)
    expect(e.play.stats.playerName).toBe("")
    expect(e.setPlay.circulations.circulationCount).toBe(0)
  })

  it("byPlayTagIDs requires ALL requested ids to be present", async () => {
    const match = rawEdition({ play: { ...rawEdition().play, tags: [{ id: "A" }, { id: "B" }] } })
    const miss = rawEdition({ play: { ...rawEdition().play, tags: [{ id: "A" }] } })
    stubFetch([match, miss])
    const { editions } = await fetchBadgeEditions({ byPlayTagIDs: ["A", "B"] })
    expect(editions).toHaveLength(1)
  })

  it("filters by bySetPlayTagIDs, byParallelIDs, byTeams, and season together", async () => {
    const keep = rawEdition({
      setPlay: { ID: "sp", tags: [{ id: "MINT" }], circulations: { circulationCount: 5 } },
      parallelID: 19,
      play: { id: "p", flowID: "1", tags: [], stats: { teamAtMomentNbaId: TRAIL_BLAZERS_NBA_ID, nbaSeason: "2024-25" } },
    })
    const wrongTeam = rawEdition({
      setPlay: { ID: "sp", tags: [{ id: "MINT" }], circulations: {} },
      parallelID: 19,
      play: { id: "p", flowID: "1", tags: [], stats: { teamAtMomentNbaId: "9999", nbaSeason: "2024-25" } },
    })
    const wrongSeason = rawEdition({
      setPlay: { ID: "sp", tags: [{ id: "MINT" }], circulations: {} },
      parallelID: 19,
      play: { id: "p", flowID: "1", tags: [], stats: { teamAtMomentNbaId: TRAIL_BLAZERS_NBA_ID, nbaSeason: "2019-20" } },
    })
    stubFetch([keep, wrongTeam, wrongSeason])
    const { editions } = await fetchBadgeEditions({
      bySetPlayTagIDs: ["MINT"],
      byParallelIDs: [19],
      byTeams: [TRAIL_BLAZERS_NBA_ID],
      byNBASeason: ["2024-25"],
    })
    expect(editions).toHaveLength(1)
    expect(editions[0].parallelID).toBe(19)
  })

  it("respects the limit (slices the filtered set)", async () => {
    stubFetch([rawEdition(), rawEdition(), rawEdition()])
    const { editions } = await fetchBadgeEditions({ limit: 2 })
    expect(editions).toHaveLength(2)
  })
})

describe("convenience wrappers call through fetchBadgeEditions", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("fetchBlazersRookieBadgeEditions issues one request and returns the shape", async () => {
    const f = stubFetch([rawEdition()])
    const out = await fetchBlazersRookieBadgeEditions()
    expect(f).toHaveBeenCalledOnce()
    expect(out).toHaveProperty("nextCursor", null)
  })

  it("fetchThreeStarRookies passes a season through without error", async () => {
    stubFetch([rawEdition()])
    const out = await fetchThreeStarRookies("2024-25")
    expect(out.editions.length).toBeGreaterThanOrEqual(0)
    expect(THREE_STAR_ROOKIE_TAG_IDS).toContain(BADGE_TAG_IDS.ROOKIE_YEAR)
  })
})
