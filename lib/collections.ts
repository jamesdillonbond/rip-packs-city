export type CollectionPage =
  | "overview"
  | "collection"
  | "packs"
  | "sniper"
  | "badges"
  | "sets"
  | "vault"

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
  flowContractAddress?: string
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
    icon: "🏀",
    pages: ["overview", "collection", "packs", "sniper", "badges", "sets"],
    published: true,
    graphqlUrl: "https://public-api.nbatopshot.com/graphql",
    flowContractName: "TopShot",
  },
  {
    id: "nfl-all-day",
    label: "NFL All Day",
    shortLabel: "All Day",
    sport: "NFL",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#4F94D4",
    icon: "🏈",
    pages: ["overview", "collection", "packs", "sniper", "sets"],
    published: true,
    graphqlUrl: "https://public-api.nflallday.com/graphql",
    flowContractName: "AllDay",
  },
  {
    id: "disney-pinnacle",
    label: "Disney Pinnacle",
    shortLabel: "Pinnacle",
    sport: "Entertainment",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#A855F7",
    icon: "✨",
    pages: ["overview", "collection", "sniper", "sets"],
    published: false,
    graphqlUrl: "https://public-api.disneypinnacle.com/graphql",
    flowContractName: "Pinnacle",
    flowContractAddress: "0xedf9df96c92f4595",
  },
  {
    id: "laliga-golazos",
    label: "LaLiga Golazos",
    shortLabel: "Golazos",
    sport: "Soccer",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#22C55E",
    icon: "⚽",
    pages: ["overview", "collection", "packs", "sniper", "sets"],
    published: false,
    graphqlUrl: "https://public-api.laligagolazos.com/graphql",
    flowContractName: "Golazos",
  },
  {
    id: "ufc",
    label: "UFC",
    shortLabel: "UFC",
    sport: "MMA",
    chain: "flow",
    partner: "Concept Labs",
    accent: "#EF4444",
    icon: "🥊",
    pages: ["overview", "collection", "sniper"],
    published: false,
    flowContractName: "UFCStrike",
  },
  {
    id: "panini-blockchain",
    label: "Panini Blockchain",
    shortLabel: "Panini",
    sport: "Multi-Sport",
    chain: "panini",
    partner: "Panini America",
    accent: "#C084FC",
    icon: "🃏",
    pages: ["overview", "collection", "packs", "sniper"],
    published: false,
  },
  {
    id: "candy-mlb",
    label: "Candy MLB",
    shortLabel: "Candy",
    sport: "MLB",
    chain: "candy",
    partner: "Futureverse",
    accent: "#FB923C",
    icon: "⚾",
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
    icon: "🏅",
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

export const PAGE_LABELS: Record<CollectionPage, string> = {
  overview:   "Overview",
  collection: "Collection",
  packs:      "Packs",
  sniper:     "Sniper",
  badges:     "Badges",
  sets:       "Sets",
  vault:      "Vault",
}
// cache-bust
