// lib/collections.ts
// Single source of truth for every collection RPC supports.
//
// Publish state as of 2026-04-20:
//   NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle — published
//   UFC Strike — unpublished (Aptos migration; near-zero on-chain volume)
//
// "market" and "analytics" pages are in the enum so every collection
// can expose a sortable marketplace browser and an ecosystem analytics
// tab distinct from overview.

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
  /** Secondary accent for hover states + tier chips. Defaults to accent. */
  accentSoft?: string
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
  /** Supabase collections.id — canonical UUID for multi-collection queries. */
  supabaseCollectionId?: string
  /** Short plain-English pitch used by SEO + empty states. */
  pitch?: string
  /** Per-collection news feed — rendered on overview. Keep 3-6 items. */
  news?: Array<{ title: string; date: string; summary: string; url: string }>
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
    accentSoft: "#FF4D40",
    icon: "\u{1F3C0}",
    pages: ["overview", "collection", "packs", "sniper", "market", "sets", "analytics", "badges"],
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
    supabaseCollectionId: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
    pitch: "Wallet analysis, FMV pricing, set completion, pack EV, and live sniper deals for NBA Top Shot collectors.",
    news: [
      { title: "2025-26: Scarcity-first drops & new parallel system", date: "2026-01-15", summary: "Dapper shifts to lower-print-run releases with redesigned parallels. LAVA tools integration live for FMV transparency.", url: "https://blog.nbatopshot.com" },
      { title: "Top Shot This (TST) — real-time minting from live games", date: "2026-01-10", summary: "Best dunks and moments minted within 24 hours and delivered directly to fans after each game.", url: "https://blog.nbatopshot.com" },
    ],
  },
  {
    id: "nfl-all-day",
    label: "NFL All Day",
    shortLabel: "All Day",
    sport: "NFL",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#4F94D4",
    accentSoft: "#6FAEF0",
    icon: "\u{1F3C8}",
    pages: ["overview", "collection", "market", "packs", "sniper", "sets", "analytics", "badges"],
    published: true,
    graphqlUrl: "https://public-api.nflallday.com/graphql",
    flowContractName: "AllDay",
    contractAddress: "0xe4cf4bdc1751c65d",
    contractName: "AllDay",
    flowtyCollectionFilter: "0xe4cf4bdc1751c65d/AllDay",
    gqlEndpoint: "https://public-api.nflallday.com/graphql",
    mediaCdnBase: "https://assets.nflallday.com",
    cadenceCollectionPath: "/public/AllDayNFTCollection",
    supabaseCollectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    pitch: "Wallet analytics, pack EV, and live marketplace intelligence for NFL All Day collectors on Flow.",
    news: [
      { title: "2025-26 base set live — weekly drops active", date: "2026-01-08", summary: "New moments minting every game week. AllDay sales indexer now tracking ~158 events/day across Flowty + AllDay native.", url: "https://nflallday.com" },
    ],
  },
  {
    id: "disney-pinnacle",
    label: "Disney Pinnacle",
    shortLabel: "Pinnacle",
    sport: "Entertainment",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#A855F7",
    accentSoft: "#C084FC",
    icon: "✨",
    pages: ["overview", "collection", "market", "sniper", "analytics"],
    published: true,
    flowContractName: "Pinnacle",
    contractAddress: "0xedf9df96c92f4595",
    contractName: "Pinnacle",
    flowtyCollectionFilter: "0xedf9df96c92f4595/Pinnacle",
    cadenceCollectionPath: "/public/PinnacleCollection",
    supabaseCollectionId: "7dd9dd11-e8b6-45c4-ac99-71331f959714",
    pitch: "Wallet analytics and marketplace intelligence for Disney Pinnacle — 231 editions enriched, 97 FMV live.",
    news: [
      { title: "Pinnacle on Flow — 231 editions tracked, block-event sales backfill in progress", date: "2026-03-28", summary: "653 historical sales being resolved via Cadence block event scan.", url: "https://disneypinnacle.com" },
    ],
  },
  {
    id: "laliga-golazos",
    label: "LaLiga Golazos",
    shortLabel: "Golazos",
    sport: "Soccer",
    chain: "flow",
    partner: "Dapper Labs",
    accent: "#22C55E",
    accentSoft: "#4ADE80",
    icon: "⚽",
    pages: ["overview", "collection", "market", "packs", "sniper", "sets", "analytics"],
    published: true,
    graphqlUrl: "https://public-api.laligagolazos.com/graphql",
    flowContractName: "Golazos",
    contractAddress: "0x87ca73a41bb50ad5",
    contractName: "Golazos",
    flowtyCollectionFilter: "0x87ca73a41bb50ad5/Golazos",
    gqlEndpoint: "https://public-api.laligagolazos.com/graphql",
    cadenceCollectionPath: "/public/GolazosNFTCollection",
    mediaCdnBase: "https://assets.laligagolazos.com",
    supabaseCollectionId: "06248cc4-b85f-47cd-af67-1855d14acd75",
    pitch: "Wallet analytics and FMV intelligence for LaLiga Golazos on Flow — 581 editions tracked, dual-source listing sweep.",
    news: [
      { title: "2025-26 LaLiga season underway — thin-volume alert model live", date: "2026-01-02", summary: "Relative-deals RPC with 100x-floor outlier filter now active to surface genuine deals in a low-volume ecosystem.", url: "https://laligagolazos.com" },
    ],
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
    published: false,
    flowContractName: "UFC_NFT",
    contractAddress: "0x329feb3ab062d289",
    contractName: "UFC_NFT",
    flowtyCollectionFilter: "0x329feb3ab062d289/UFC_NFT",
    cadenceCollectionPath: "/public/UFC_NFTCollection",
    supabaseCollectionId: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
    pitch: "Catalog browser for UFC Strike on Flow. Near-zero on-chain volume — post-Aptos migration coverage planned.",
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
    pitch: "Reserved for Panini Blockchain integration.",
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
    pitch: "Reserved for Candy MLB integration on the Root Network.",
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
    pitch: "Reserved for real-world-asset vaulted card coverage.",
  },
]

// ── Helpers ────────────────────────────────────────────────────────────────

export function publishedCollections(): Collection[] {
  return COLLECTIONS.filter(c => c.published)
}

export function getCollection(id: string): Collection | undefined {
  return COLLECTIONS.find(c => c.id === id)
}

export function getPublishedCollection(id: string): Collection | undefined {
  return publishedCollections().find(c => c.id === id)
}

export function requirePublishedCollection(id: string): Collection {
  const c = getPublishedCollection(id)
  if (!c) throw new Error(`Collection not published or not found: ${id}`)
  return c
}

export function collectionHasPage(id: string, page: CollectionPage): boolean {
  const c = getCollection(id)
  return !!c && c.pages.includes(page)
}

// ── Marketplace URL builders ────────────────────────────────────────────────
// Standalone helpers (not methods on Collection) so Collection objects stay
// serializable across the RSC boundary — server components can freely pass
// a Collection to client components without triggering "Functions cannot be
// passed directly to Client Components".

const MARKETPLACE_MOMENT_URL_TEMPLATES: Record<string, (id: string) => string> = {
  "nba-top-shot":    (id) => `https://nbatopshot.com/moment/${id}`,
  "nfl-all-day":     (id) => `https://nflallday.com/moment/${id}`,
  "laliga-golazos":  (id) => `https://laligagolazos.com/moment/${id}`,
  "disney-pinnacle": (id) => `https://disneypinnacle.com/pin/${id}`,
}

const MARKETPLACE_WALLET_URL_TEMPLATES: Record<string, (addr: string) => string> = {
  "nba-top-shot":    (addr) => `https://nbatopshot.com/user/${addr}`,
  "nfl-all-day":     (addr) => `https://nflallday.com/collection/${addr}`,
  "laliga-golazos":  (addr) => `https://laligagolazos.com/collection/${addr}`,
  "disney-pinnacle": (addr) => `https://disneypinnacle.com/collection/${addr}`,
}

export function marketplaceMomentUrl(collectionId: string, flowId: string): string | null {
  const f = MARKETPLACE_MOMENT_URL_TEMPLATES[collectionId]
  return f ? f(flowId) : null
}

export function marketplaceWalletUrl(collectionId: string, address: string): string | null {
  const f = MARKETPLACE_WALLET_URL_TEMPLATES[collectionId]
  return f ? f(address) : null
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

// ── Page labels + pitches ───────────────────────────────────────────────────

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

// One-line page pitches — rendered under tab hovers and in empty states.
export const PAGE_PITCHES: Record<CollectionPage, string> = {
  overview:   "Ecosystem snapshot, news, pipeline health",
  collection: "Your moments — FMV, badges, acquisition history",
  market:     "Sort and filter every listing in the ecosystem",
  packs:      "Pack EV calculator — find drops where EV > retail",
  sniper:     "Real-time deals below FMV",
  badges:     "Top Shot Debut, Rookie Year, Championship, and more",
  sets:       "Completion tracking and bottleneck finder",
  analytics:  "Sortable ecosystem-wide intelligence",
  vault:      "Real-world-asset vaulted cards",
}
