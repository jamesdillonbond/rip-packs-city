import { describe, it, expect } from "vitest"
import {
  BADGE_TAG_IDS,
  getBadges,
  isThreeStarRookie,
  hasRookieMint,
  badgeScore,
  burnRate,
  lockRate,
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
