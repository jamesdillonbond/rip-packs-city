/**
 * RPC Badge Integration
 * Endpoint: https://public-api.nbatopshot.com/graphql (same as topshot-graphql.ts)
 * Badge UUIDs confirmed from live API intercept 2026-03-25
 */

// ============================================================
// CONFIRMED BADGE TAG IDs (from live intercept 2026-03-25)
// ============================================================
export const BADGE_TAG_IDS = {
  // PLAY-level badges (filter with byPlayTagIDs)
  ROOKIE_YEAR:        "2dbd4eef-4417-451b-b645-90f02574a401",
  ROOKIE_PREMIERE:    "0ddb2c58-4385-443b-9c70-239b32cddbd4",
  TOP_SHOT_DEBUT:     "a75e247a-ecbf-45a6-b1be-58bb07a1b651",
  ROOKIE_OF_THE_YEAR: "34fe8d3f-681a-42df-856a-e98624f95b11",
  // SETPLAY-level badges (filter with bySetPlayTagIDs)
  ROOKIE_MINT:        "24d515af-e967-45f5-a30e-11fc96dc2b62",
  // Internal/hidden — never display to users
  INTERACTIVE:        "9bbb6f91-d09a-4d07-ab3d-8402a9c10cf1",
  CHAMPIONSHIP_YEAR:  "f197f60a-b502-4386-b0c0-7f4cde8164ff",
} as const

// GQL badge type strings → display titles. Used by the collection page to
// render officialBadges (SCREAMING_SNAKE_CASE from GQL) as SVG icons.
export const BADGE_TYPE_TO_TITLE: Record<string, string> = {
  ROOKIE_YEAR:        "Rookie Year",
  ROOKIE_PREMIERE:    "Rookie Premiere",
  TOP_SHOT_DEBUT:     "Top Shot Debut",
  ROOKIE_OF_THE_YEAR: "Rookie of the Year",
  ROOKIE_MINT:        "Rookie Mint",
  CHAMPIONSHIP_YEAR:  "Championship Year",
}

export const THREE_STAR_ROOKIE_TAG_IDS = [
  BADGE_TAG_IDS.ROOKIE_YEAR,
  BADGE_TAG_IDS.ROOKIE_PREMIERE,
  BADGE_TAG_IDS.TOP_SHOT_DEBUT,
]

// ============================================================
// CONFIRMED PARALLEL IDs
// ============================================================
export const PARALLEL_IDS = {
  STANDARD:   0,
  BLOCKCHAIN: 17,
  HARDCOURT:  18,
  HEXWAVE:    19,
  JUKEBOX:    20,
} as const

// ============================================================
// CONFIRMED NBA TEAM IDs
// ============================================================
export const TRAIL_BLAZERS_NBA_ID = "1610612757"

// ============================================================
// NETWORK CONFIG (matches topshot-graphql.ts exactly)
// ============================================================
const TS_PUBLIC_API = "https://public-api.nbatopshot.com/graphql"
const REQUEST_TIMEOUT_MS = 12_000
const BROWSER_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "sports-collectible-tool/0.1",
}

// ============================================================
// GRAPHQL QUERY
// ============================================================
const SEARCH_EDITIONS_WITH_TAGS = `
  query SearchEditionsWithTags($setID: ID, $playID: ID, $first: Int!) {
    searchEditions(input: { setID: $setID, playID: $playID, first: $first }) {
      data {
        set {
          id
          flowName
          flowSeriesNumber
        }
        play {
          id
          flowID
          stats {
            playerName
            firstName
            lastName
            dateOfMoment
            playCategory
            teamAtMoment
            teamAtMomentNbaId
            nbaSeason
            jerseyNumber
            playerID
          }
          tags {
            id
            title
            visible
            level
          }
        }
        setPlay {
          ID
          flowRetired
          circulationCount
          tags {
            id
            title
            visible
            level
          }
          circulations {
            burned
            circulationCount
            forSaleByCollectors
            hiddenInPacks
            ownedByCollectors
            locked
            effectiveSupply
          }
        }
        stats {
          lowestAsk
          averagePrice
          totalSales
        }
        tier
        parallelID
        parallelName
      }
    }
  }
`

// ============================================================
// TYPE DEFINITIONS
// ============================================================
export interface Tag {
  id: string
  title: string
  visible: boolean
  level: "PLAY" | "SETPLAY"
}

export interface Circulations {
  burned: number
  circulationCount: number
  forSaleByCollectors: number
  hiddenInPacks: number
  ownedByCollectors: number
  locked: number
  effectiveSupply: number
  ownedByCollectorsExcludingListedAndLocked: number
}

export interface MarketplaceEdition {
  id: string
  assetPathPrefix: string
  tier: "MOMENT_TIER_COMMON" | "MOMENT_TIER_RARE" | "MOMENT_TIER_LEGENDARY"
  parallelID: number
  parallelName: string
  set: {
    id: string
    flowName: string
    flowSeriesNumber: number
    setVisualId: string
  }
  play: {
    id: string
    flowID: string
    headline: string
    stats: {
      playerName: string
      firstName: string
      lastName: string
      dateOfMoment: string
      playCategory: string
      teamAtMomentNbaId: string
      teamAtMoment: string
      nbaSeason: string
      jerseyNumber: string
      playerID: string
    }
    statsPlayerGameScores: {
      points: number
      assists: number
      rebounds: number
    }
    tags: Tag[]
  }
  setPlay: {
    ID: string
    flowRetired: boolean
    tags: Tag[] | null
    circulations: Circulations
  }
  lowAsk: number
  highestOffer: number
  circulationCount: number
  effectiveSupply: number
  burned: number
  locked: number
  owned: number
  hiddenInPacks: number
  averageSaleData: {
    averagePrice: string
    numDays: number
    numSales: number
  }
  marketplaceStats: {
    price: number
    averageSalePrice: number
    change24h: number
    change7d: number
    change30d: number
    volume24h: number
    volume7d: number
    volume30d: number
    highestOffer: number
  }
  editionListingCount: number
  uniqueSellerCount: number
  userOwnedCount: number
  userLockedCount: number
}

// ============================================================
// BADGE UTILITY FUNCTIONS
// ============================================================

export function getBadges(edition: MarketplaceEdition): string[] {
  const playBadges = edition.play.tags
    .filter((t) => t.visible)
    .map((t) => t.title)
  const setPlayBadges = (edition.setPlay.tags ?? [])
    .filter((t) => t.visible)
    .map((t) => t.title)
  return [...new Set([...playBadges, ...setPlayBadges])]
}

export function isThreeStarRookie(edition: MarketplaceEdition): boolean {
  const playTagIds = new Set(edition.play.tags.map((t) => t.id))
  return (
    playTagIds.has(BADGE_TAG_IDS.ROOKIE_YEAR) &&
    playTagIds.has(BADGE_TAG_IDS.ROOKIE_PREMIERE) &&
    playTagIds.has(BADGE_TAG_IDS.TOP_SHOT_DEBUT)
  )
}

export function hasRookieMint(edition: MarketplaceEdition): boolean {
  return (edition.setPlay.tags ?? []).some(
    (t) => t.id === BADGE_TAG_IDS.ROOKIE_MINT
  )
}

export function badgeScore(edition: MarketplaceEdition): number {
  let score = 0
  const playTagIds = new Set(edition.play.tags.map((t) => t.id))
  const setPlayTagIds = new Set((edition.setPlay.tags ?? []).map((t) => t.id))
  if (playTagIds.has(BADGE_TAG_IDS.ROOKIE_YEAR)) score += 1
  if (playTagIds.has(BADGE_TAG_IDS.ROOKIE_PREMIERE)) score += 1
  if (playTagIds.has(BADGE_TAG_IDS.TOP_SHOT_DEBUT)) score += 1
  if (setPlayTagIds.has(BADGE_TAG_IDS.ROOKIE_MINT)) score += 1
  if (isThreeStarRookie(edition) && hasRookieMint(edition)) score += 4
  if (playTagIds.has(BADGE_TAG_IDS.ROOKIE_OF_THE_YEAR)) score += 3
  return score
}

export function burnRate(edition: MarketplaceEdition): number {
  const total = edition.setPlay.circulations.circulationCount
  if (!total) return 0
  return (edition.setPlay.circulations.burned / total) * 100
}

export function lockRate(edition: MarketplaceEdition): number {
  const owned = edition.setPlay.circulations.ownedByCollectors
  if (!owned) return 0
  return (edition.setPlay.circulations.locked / owned) * 100
}

// ============================================================
// FETCH FUNCTION
// ============================================================
export async function fetchBadgeEditions(options: {
  byPlayTagIDs?: string[]
  bySetPlayTagIDs?: string[]
  byTeams?: string[]
  byNBASeason?: string[]
  byParallelIDs?: number[]
  cursor?: string
  limit?: number
}): Promise<{ editions: MarketplaceEdition[]; nextCursor: string | null }> {
  const {
    byPlayTagIDs = [],
    bySetPlayTagIDs = [],
    byTeams = [],
    byNBASeason = [],
    byParallelIDs = [],
    limit = 24,
  } = options

  const season = byNBASeason[0] ?? undefined

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  const response = await fetch(TS_PUBLIC_API, {
    method: "POST",
    headers: BROWSER_HEADERS,
    body: JSON.stringify({
      query: SEARCH_EDITIONS_WITH_TAGS,
      variables: {
        first: 250,
      },
    }),
    signal: controller.signal,
  })

  clearTimeout(timeout)

  if (!response.ok) {
    throw new Error(`Top Shot API error: ${response.status}`)
  }

  const json = await response.json()
  const rawEditions: any[] = json?.data?.searchEditions?.data ?? []

  // Client-side filtering by badge UUIDs, parallel, team, season
  let filtered = rawEditions.filter((e: any) => {
    const playTagIds = (e.play?.tags ?? []).map((t: any) => t.id)
    const setPlayTagIds = (e.setPlay?.tags ?? []).map((t: any) => t.id)

    if (byPlayTagIDs.length > 0) {
      const hasAll = byPlayTagIDs.every((id) => playTagIds.includes(id))
      if (!hasAll) return false
    }

    if (bySetPlayTagIDs.length > 0) {
      const hasAll = bySetPlayTagIDs.every((id) => setPlayTagIds.includes(id))
      if (!hasAll) return false
    }

    if (byParallelIDs.length > 0 && !byParallelIDs.includes(e.parallelID ?? 0)) {
      return false
    }

    if (byTeams.length > 0 && !byTeams.includes(e.play?.stats?.teamAtMomentNbaId ?? "")) {
      return false
    }

    if (season && e.play?.stats?.nbaSeason !== season) {
      return false
    }

    return true
  })

  filtered = filtered.slice(0, limit)

  // Normalize to MarketplaceEdition shape
  const editions: MarketplaceEdition[] = filtered.map((e: any) => ({
    id: `${e.set?.id}+${e.play?.id}+${e.parallelID ?? 0}`,
    assetPathPrefix: "",
    tier: e.tier ?? "MOMENT_TIER_COMMON",
    parallelID: e.parallelID ?? 0,
    parallelName: e.parallelName ?? "",
    set: {
      id: e.set?.id ?? "",
      flowName: e.set?.flowName ?? "",
      flowSeriesNumber: e.set?.flowSeriesNumber ?? 0,
      setVisualId: "",
    },
    play: {
      id: e.play?.id ?? "",
      flowID: e.play?.flowID ?? "",
      headline: e.play?.stats?.playerName ?? "",
      stats: {
        playerName: e.play?.stats?.playerName ?? "",
        firstName: e.play?.stats?.firstName ?? "",
        lastName: e.play?.stats?.lastName ?? "",
        dateOfMoment: e.play?.stats?.dateOfMoment ?? "",
        playCategory: e.play?.stats?.playCategory ?? "",
        teamAtMomentNbaId: e.play?.stats?.teamAtMomentNbaId ?? "",
        teamAtMoment: e.play?.stats?.teamAtMoment ?? "",
        nbaSeason: e.play?.stats?.nbaSeason ?? "",
        jerseyNumber: e.play?.stats?.jerseyNumber ?? "",
        playerID: e.play?.stats?.playerID ?? "",
      },
      statsPlayerGameScores: { points: 0, assists: 0, rebounds: 0 },
      tags: e.play?.tags ?? [],
    },
    setPlay: {
      ID: e.setPlay?.ID ?? "",
      flowRetired: e.setPlay?.flowRetired ?? false,
      tags: e.setPlay?.tags ?? null,
      circulations: {
        burned: e.setPlay?.circulations?.burned ?? 0,
        circulationCount:
          e.setPlay?.circulations?.circulationCount ??
          e.setPlay?.circulationCount ?? 0,
        forSaleByCollectors: e.setPlay?.circulations?.forSaleByCollectors ?? 0,
        hiddenInPacks: e.setPlay?.circulations?.hiddenInPacks ?? 0,
        ownedByCollectors: e.setPlay?.circulations?.ownedByCollectors ?? 0,
        locked: e.setPlay?.circulations?.locked ?? 0,
        effectiveSupply: e.setPlay?.circulations?.effectiveSupply ?? 0,
        ownedByCollectorsExcludingListedAndLocked: 0,
      },
    },
    lowAsk: e.stats?.lowestAsk ?? 0,
    highestOffer: 0,
    circulationCount: e.setPlay?.circulationCount ?? 0,
    effectiveSupply: e.setPlay?.circulations?.effectiveSupply ?? 0,
    burned: e.setPlay?.circulations?.burned ?? 0,
    locked: e.setPlay?.circulations?.locked ?? 0,
    owned: e.setPlay?.circulations?.ownedByCollectors ?? 0,
    hiddenInPacks: e.setPlay?.circulations?.hiddenInPacks ?? 0,
    averageSaleData: {
      averagePrice: String(e.stats?.averagePrice ?? "0"),
      numDays: 30,
      numSales: e.stats?.totalSales ?? 0,
    },
    marketplaceStats: {
      price: e.stats?.lowestAsk ?? 0,
      averageSalePrice: e.stats?.averagePrice ?? 0,
      change24h: 0,
      change7d: 0,
      change30d: 0,
      volume24h: 0,
      volume7d: 0,
      volume30d: 0,
      highestOffer: 0,
    },
    editionListingCount: 0,
    uniqueSellerCount: 0,
    userOwnedCount: 0,
    userLockedCount: 0,
  }))

  return { editions, nextCursor: null }
}

// ============================================================
// CONVENIENCE WRAPPERS
// ============================================================
export async function fetchBlazersRookieBadgeEditions() {
  return fetchBadgeEditions({
    byTeams: [TRAIL_BLAZERS_NBA_ID],
    byPlayTagIDs: [BADGE_TAG_IDS.ROOKIE_YEAR],
  })
}

export async function fetchThreeStarRookies(season?: string) {
  return fetchBadgeEditions({
    byPlayTagIDs: THREE_STAR_ROOKIE_TAG_IDS,
    bySetPlayTagIDs: [BADGE_TAG_IDS.ROOKIE_MINT],
    byNBASeason: season ? [season] : [],
  })
}