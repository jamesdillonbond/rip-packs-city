export type CollectionPage =
  | "overview"
  | "collection"
  | "packs"
  | "sniper"
  | "badges"
  | "sets"
  | "vault"
  | "market"

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
    icon: "🏀",
    pages: ["overview", "collection", "packs", "sniper", "market", "sets"],
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
    icon: "🏈",
    pages: ["overview", "collection", "packs", "sniper", "sets"],
    published: false,
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
    icon: "✨",
    pages: ["overview", "collection", "sniper"],
    published: false,
    graphqlUrl: "https://public-api.disneypinnacle.com/graphql",
    flowContractName: "Pinnacle",
    contractAddress: "0xedf9df96c92f4595",
    contractName: "Pinnacle",
    flowtyCollectionFilter: "0xedf9df96c92f4595/Pinnacle",
    gqlEndpoint: "https://public-api.disneypinnacle.com/graphql",
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
    icon: "⚽",
    pages: ["overview", "collection", "packs", "sniper", "sets"],
    published: false,
    graphqlUrl: "https://public-api.laligagolazos.com/graphql",
    flowContractName: "Golazos",
    contractAddress: "0x87ca73a41bb50ad5",
    contractName: "Golazos",
    flowtyCollectionFilter: "0x87ca73a41bb50ad5/Golazos",
    gqlEndpoint: "https://public-api.laligagolazos.com/graphql",
    cadenceCollectionPath: "/public/GolazosNFTCollection",
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
    icon: "🃏",
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
  market:     "Market",
}
// cache-bust
