export type CollectionPage =
  | "overview"
  | "collection"
  | "packs"
  | "sniper"
  | "badges"
  | "sets"
  | "vault"
  | "market"
  | "analytics"

export interface Collection {
  id: string
  label: string
  shortLabel: string
  sport: string
  chain: "flow" | "evm" | "panini" | "candy" | "rwa"
  partner: string
  accent: string
  icon: string
  pages: CollectionPage[]
  published: boolean
  graphqlUrl?: string
  flowContractName?: string
  openSeaSlug?: string
  contractAddress?: string
  contractName?: string
  flowtyCollectionFilter?: string
  gqlEndpoint?: string
  gqlProxyPath?: string
  mediaCdnBase?: string
  cadenceCollectionPath?: string
}

export const COLLECTIONS: Collection[] = [
  {
    id: "nba-top-shot",
    label: "NBA Top Shot",
    shortLabel: "Top Shot",
    sport: "NBA",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#E03A2F",
    icon: "\u{1F3C0}",
    pages: ["overview", "collection", "packs", "sniper", "market", "sets", "analytics"],
    published: true,
    graphqlUrl: "https://public-api.nbatopshot.com/graphql",
    flowContractName: "TopShot",
    contractAddress: "0x0b2a3299cc857e29",
    contractName: "TopShot",
    flowtyCollectionFilter: "0x0b2a3299cc857e29/TopShot",
    gqlEndpoint: "https://public-api.nbatopshot.com/graphql",
    gqlProxyPath: "/topshot",
    mediaCdnBase: "https://assets.nbatopshot.com",
    cadenceCollectionPath: "/public/MomentCollection",
  },
  {
    id: "nfl-all-day",
    label: "NFL All Day",
    shortLabel: "All Day",
    sport: "NFL",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#4F94D4",
    icon: "\u{1F3C8}",
    pages: ["overview", "collection", "packs", "sniper", "sets", "badges", "analytics"],
    published: true,
    graphqlUrl: "https://public-api.nflallday.com/graphql",
    flowContractName: "AllDay",
    contractAddress: "0xe4cf4bdc1751c65d",
    contractName: "AllDay",
    flowtyCollectionFilter: "0xe4cf4bdc1751c65d/AllDay",
    gqlEndpoint: "https://public-api.nflallday.com/graphql",
    mediaCdnBase: "https://assets.nflallday.com",
    cadenceCollectionPath: "/public/AllDayNFTCollection",
  },
  {
    id: "disney-pinnacle",
    label: "Disney Pinnacle",
    shortLabel: "Pinnacle",
    sport: "Entertainment",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#A855F7",
    icon: "\u2728",
    pages: ["overview", "collection", "sniper", "analytics"],
    published: true,
    flowContractName: "Pinnacle",
    contractAddress: "0xedf9df96c92f4595",
    contractName: "Pinnacle",
    flowtyCollectionFilter: "0xedf9df96c92f4595/Pinnacle",
    cadenceCollectionPath: "/public/PinnacleCollection",
  },
  {
    id: "laliga-golazos",
    label: "LaLiga Golazos",
    shortLabel: "Golazos",
    sport: "Soccer",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#22C55E",
    icon: "\u26BD",
    pages: ["overview", "collection", "packs", "sniper", "sets", "analytics"],
    published: true,
    graphqlUrl: "https://public-api.laligagolazos.com/graphql",
    flowContractName: "Golazos",
    contractAddress: "0x87ca73a41bb50ad5",
    contractName: "Golazos",
    flowtyCollectionFilter: "0x87ca73a41bb50ad5/Golazos",
    gqlEndpoint: "https://public-api.laligagolazos.com/graphql",
    cadenceCollectionPath: "/public/GolazosNFTCollection",
    mediaCdnBase: "https://assets.laligagolazos.com",
  },
  {
    id: "ufc",
    label: "UFC Strike",
    shortLabel: "Strike",
    sport: "MMA",
    chain: "flow",
    partner: "Concept Labs",
    accent: "#EF4444",
    icon: "\u{1F94A}",
    pages: ["overview", "collection", "sniper", "analytics"],
    published: true,
    flowContractName: "UFC_NFT",
    contractAddress: "0x329feb3ab062d289",
    contractName: "UFC_NFT",
    flowtyCollectionFilter: "0x329feb3ab062d289/UFC_NFT",
    cadenceCollectionPath: "/public/UFC_NFTCollection",
  },
  {
    id: "panini-blockchain",
    label: "Panini Blockchain",
    shortLabel: "Panini",
    sport: "Multi-Sport",
    chain: "panini",
    partner: "Panini America",
    accent: "#C084FC",
    icon: "\u{1F0CF}",
    pages: ["overview", "sniper"],
    published: false,
    openSeaSlug: "paniniblockchain",
  },
  {
    id: "candy-mlb",
    label: "Candy MLB",
    shortLabel: "Candy",
    sport: "MLB",
    chain: "candy",
    partner: "Futureverse",
    accent: "#FB923C",
    icon: "\u26BE",
    pages: ["overview", "collection", "packs", "sniper"],
    published: false,
  },
  {
    id: "rwa",
    label: "RWA Vaulted",
    shortLabel: "RWA",
    sport: "Multi-Sport",
    chain: "rwa",
    partner: "Courtyard / Beezie",
    accent: "#F59E0B",
    icon: "\u{1F3C5}",
    pages: ["overview", "collection", "sniper", "vault"],
    published: false,
  },
]

export function publishedCollections(): Collection[] {
  return COLLECTIONS.filter(c => c.published)
}

export function getCollection(id: string): Collection | undefined {
  return COLLECTIONS.find(c => c.id === id)
}

export function getPublishedCollection(id: string): Collection | undefined {
  return publishedCollections().find(c => c.id === id)
}

// ── DB bridges ──────────────────────────────────────────────────────────────
// The frontend uses hyphen slugs ("nba-top-shot"); Postgres functions and
// `collections` rows use underscore slugs ("nba_top_shot", "ufc_strike").
// Centralise the mapping so routes and components don't drift.

export const SLUG_TO_DB_SLUG: Record<string, string> = {
  "nba-top-shot":    "nba_top_shot",
  "nfl-all-day":     "nfl_all_day",
  "laliga-golazos":  "laliga_golazos",
  "ufc":             "ufc_strike",
  "disney-pinnacle": "disney_pinnacle",
}

export const DB_SLUG_TO_SLUG: Record<string, string> = Object.fromEntries(
  Object.entries(SLUG_TO_DB_SLUG).map(([a, b]) => [b, a])
)

export const COLLECTION_UUID_BY_SLUG: Record<string, string> = {
  "nba-top-shot":    "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day":     "dee28451-5d62-409e-a1ad-a83f763ac070",
  "laliga-golazos":  "06248cc4-b85f-47cd-af67-1855d14acd75",
  "ufc":             "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  "disney-pinnacle": "7dd9dd11-e8b6-45c4-ac99-71331f959714",
}

export function toDbSlug(slug: string): string | null {
  return SLUG_TO_DB_SLUG[slug] ?? null
}

export function fromDbSlug(dbSlug: string): string | null {
  return DB_SLUG_TO_SLUG[dbSlug] ?? null
}

export function getCollectionUuid(slug: string): string | null {
  return COLLECTION_UUID_BY_SLUG[slug] ?? null
}

export const PAGE_LABELS: Record<CollectionPage, string> = {
  overview:   "Overview",
  collection: "Collection",
  packs:      "Packs",
  sniper:     "Sniper",
  badges:     "Badges",
  sets:       "Sets",
  vault:      "Vault",
  market:     "Market",
  analytics:  "Analytics",
}
// cache-bust
