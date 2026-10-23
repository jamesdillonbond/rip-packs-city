// lib/insights/board-registry.ts
//
// The one place each public /insights board says WHAT IT IS — for structured
// data, the default OG card and the AI-crawler index (public/llms.txt).
//
// ── WHY THIS EXISTS (2026-10-11, platform review §3 E1) ─────────────────────
// 23 of 32 board layouts each spelled their own JSON-LD object inline: a
// `WebApplication` with `applicationCategory: FinanceApplication` and a `$0
// Offer` — the ROOT layout's node, copy-pasted per board since the first board
// shipped (a5013bf8, 2026-05-29). Google has no rich result for a web app and
// nothing in that node described the board; the 9 newest layouts emitted
// nothing. Meanwhile every `Dataset` node on the estate (14) sat under the
// auth-gated, unlisted app/(analytics) tree, where no crawler can read it.
//
// The fix is one registry + one helper (`insightsBoardJsonLd` in lib/seo.ts)
// instead of 32 hand-maintained objects. A `dataset` board becomes a
// schema.org Dataset whose `distribution` is its public JSON route when one
// exists; a `tool` (the wallet-paste surfaces) stays a WebApplication — a
// "paste your wallet" lookup is not a dataset, and calling it one would be the
// mirror of the defect this fixes.
//
// ⚠ `name` / `description` were lifted VERBATIM from the inline nodes (or, for
// the 9 layouts without one, from their `metadata`). They are not the <title>:
// a Dataset name is a label for the data, the title is a search-result pitch.
//
// ⚠ `publicApi` is pinned against a TREE WALK of app/api/public/insights/ by
// __tests__/insights-layouts-emit-dataset-json-ld.test.ts — a flag here that
// disagrees with the directory reds CI, so this list cannot go stale silently.
// The wallet tools' routes (squeeze-check, tc-report) take a required
// `?wallet=` and are therefore NOT a DataDownload; they stay `publicApi: false`.

export type InsightsBoardKind = "dataset" | "tool"

export type InsightsBoard = {
  /** The /insights/<slug> path segment AND the app/insights/<slug>/ directory. */
  slug: string
  kind: InsightsBoardKind
  /** schema.org `name` — what the data IS, not the SEO title. */
  name: string
  /** schema.org `description` — one or two sentences, no baked counts. */
  description: string
  /** True iff app/api/public/insights/<slug>/route.ts serves the board's default JSON with no required params. */
  publicApi: boolean
}

export const INSIGHTS_BOARDS: readonly InsightsBoard[] = [
  {
    slug: "account-value",
    kind: "tool",
    name: "Account Value Calculator",
    description:
      "Paste a Top Shot username or Flow wallet and see the account's total value — live FMV across every moment it holds, for NBA Top Shot, NFL All Day, Disney Pinnacle, LaLiga Golazos and UFC Strike.",
    publicApi: false,
  },
  {
    slug: "allday-pack-market",
    kind: "dataset",
    name: "NFL All Day Pack Market",
    description:
      "Ranks NFL All Day sealed packs by what they actually resell for on the secondary market vs their original drop price, from the complete on-chain sale history. Packs with 5+ secondary sales qualify.",
    publicApi: true,
  },
  {
    slug: "allday-pack-reality",
    kind: "dataset",
    name: "NFL All Day Pack Reality",
    description:
      "Compares each NFL All Day pack's odds-corrected modeled EV against the value its opened packs actually delivered, resolved on-chain. Sparse-data and stale-FMV dists are excluded.",
    publicApi: true,
  },
  {
    slug: "allday-scarcity",
    kind: "dataset",
    name: "NFL All Day Scarcity Board",
    description:
      "NFL All Day editions ranked by how far below their set and tier family's average mint they sit — low-mint parallels, #1 mints and premium tiers.",
    publicApi: true,
  },
  {
    slug: "autographs",
    kind: "dataset",
    name: "Autographed Moments",
    description:
      "Every signed NBA Top Shot and NFL All Day edition, read from Dapper's own autograph data, with its lowest live ask, recent sales, and the price of the same Moment unsigned.",
    publicApi: true,
  },
  {
    slug: "candy-mlb",
    kind: "dataset",
    name: "Candy MLB ICONs — Solana Secondary Market Intelligence",
    description:
      "2026 MLB Base Series ICONs (Candy Digital / Solana): live secondary FMV, best offers, bid-ask spread, pack expected value and holder concentration across every ICON and Rainbow variant.",
    publicApi: true,
  },
  {
    slug: "cross-collection",
    kind: "dataset",
    name: "Cross-Collection Whale Map",
    // ⚠ Count-free on purpose: the cohort is a growing population that this
    // board's metadata READS live (see its layout). A number here would be the
    // "143 wallets" defect re-baked.
    description:
      "Flow wallets that hold 3+ collections — Top Shot, All Day, Golazos, Pinnacle, UFC Strike — with their cohort distribution, the top wallets and the Top Shot sets they actually collect.",
    publicApi: true,
  },
  {
    slug: "deals",
    kind: "dataset",
    name: "Below FMV — Top Shot, All Day + Pinnacle Deals vs Fair Value",
    // ⚠ This description once ended "Refreshes continuously." — a liveness claim
    // retired everywhere on 2026-08-29, and structured data is the WORST place
    // for one (machine-read, not merely displayed). The board reports per-row
    // ask ages; the description says what the board IS.
    description:
      "Ranks NBA Top Shot, NFL All Day and Disney Pinnacle editions listed below a fair value priced from recent corroborated sales, by discount. Every ask carries the time we last confirmed it.",
    publicApi: true,
  },
  {
    slug: "first-mint",
    kind: "dataset",
    name: "Top Shot First-Mint Trophy Tracker",
    description:
      "Quantifies the first-mint trophy thesis on NBA Top Shot — every serial #1 sale of the last 90 days with the multiplier vs the average-serial price. Refreshes hourly.",
    publicApi: true,
  },
  {
    slug: "market",
    kind: "dataset",
    name: "The RPC Index",
    description:
      "A tier-segmented daily market index for NBA Top Shot built from real secondary-market sales. Each tier is normalized to 100 at the start of the window.",
    publicApi: true,
  },
  {
    slug: "market-cap",
    kind: "dataset",
    name: "Market Cap — Flow digital collectibles",
    description:
      "Market cap for each Flow digital-collectible collection and for its players, teams, sets, series, tiers and badges: fair market value times collector-held supply (minted minus burned minus issuer-held).",
    publicApi: true,
  },
  {
    slug: "market-pulse",
    kind: "dataset",
    name: "Market Pulse",
    description: "Per-collection Flow secondary-market volume, sales, buyers and sellers across 24h/7d/30d.",
    publicApi: true,
  },
  {
    slug: "new-collectors",
    kind: "dataset",
    name: "New Collectors — Top Shot Acquisition Funnel",
    description:
      "Tracks who is entering NBA Top Shot — new vs returning buyers, first-buy price, gateway sets and players, and monthly cohort retention and LTV — from buyer-resolved on-chain sales.",
    publicApi: true,
  },
  {
    slug: "offer-spread",
    kind: "dataset",
    name: "Bid vs Floor — Top Shot Offer/Ask Spread",
    // Same "Refreshes continuously." history as `deals` above.
    description:
      "Ranks NBA Top Shot editions by how tightly the top standing offer meets the floor ask. Every floor ask carries the time we last confirmed it.",
    publicApi: true,
  },
  {
    slug: "pack-drops",
    kind: "dataset",
    name: "Pack Drops — Re-Pack Value Scanner",
    description:
      "Scores Vaultopolis re-pack drops of real NBA Top Shot moments against RPC FMV — RPC pool, pack expected value vs the FLOW listing price, value concentration, and published odds.",
    publicApi: true,
  },
  {
    slug: "pack-reality",
    kind: "dataset",
    name: "Top Shot Pack Reality",
    description:
      "Audits every NBA Top Shot pack ripped in the last 60 days. Pull-value histogram, KPIs, and an honest +EV pack ranker that shows how many rips each verdict rests on.",
    publicApi: true,
  },
  {
    slug: "pack-sniper",
    kind: "dataset",
    name: "Pack Sniper — Sealed Pack Deals vs Expected Value",
    description:
      "Ranks currently-listed NBA Top Shot (and NFL All Day) sealed packs by live secondary ask versus drop-weighted expected pull value. Refreshes every few minutes.",
    publicApi: true,
  },
  {
    slug: "panini-premiums",
    kind: "dataset",
    name: "Panini Premiums",
    description:
      "Ranks Panini digital-card parallels by the premium their FMV commands over the player's common base parallel, and #1 / perfect-mint serial sales by their multiple over the edition's typical sale.",
    publicApi: false,
  },
  {
    slug: "panini-squeeze",
    kind: "dataset",
    name: "Panini WC Prizm Squeeze",
    description:
      "Which 2026 Panini Prizm World Cup Soccer cards are still sealed in unopened packs — remaining supply, rip %, FMV and sealed-dollar exposure across every player and parallel. A floor, not a census.",
    publicApi: true,
  },
  {
    slug: "parallel-premiums",
    kind: "dataset",
    name: "Parallel Premiums",
    description:
      "Ranks NBA Top Shot parallel (subedition) editions by the premium their FMV commands over the Standard base edition of the same play.",
    publicApi: true,
  },
  {
    slug: "pinnacle-scarcity",
    kind: "dataset",
    name: "Disney Pinnacle Scarcity Board",
    description:
      "Disney Pinnacle editions ranked by how far below their variant family's average mint they sit — chasers, low-mint Standards and premium variants.",
    publicApi: true,
  },
  {
    slug: "rookie-board",
    kind: "dataset",
    name: "Rookie Board — 2025 Class",
    description:
      "Breaks every 2025 NBA Top Shot rookie edition out by parallel with per-parallel FMV, circulation, ask, burn and lock rates from real on-chain data.",
    publicApi: true,
  },
  {
    slug: "rookies",
    kind: "dataset",
    name: "NBA Rookie Class Index — 2025 & 2026",
    description:
      "Per-player 30-day GMV, lock-rate, and first-mint trophy presence for the 2025 and 2026 NBA rookie classes on Top Shot. Refreshes hourly.",
    publicApi: true,
  },
  {
    slug: "serial-premiums",
    kind: "dataset",
    name: "Serial Premiums — #1 Watch",
    description:
      "Ranks NBA Top Shot editions by how much more the #1 serial sold for than the edition's typical price, using real on-chain sales.",
    publicApi: true,
  },
  {
    slug: "set-completers",
    kind: "dataset",
    name: "Set Completers — 2025 Rookie Set Completion",
    description:
      "Tracks how many collectors have completed each 2025 NBA Top Shot rookie set (base-play completion) from the indexed on-chain ownership graph — completers, holders, and completion rate per set.",
    publicApi: true,
  },
  {
    slug: "set-squeeze",
    kind: "dataset",
    name: "Top Shot Set Squeeze Leaderboard",
    description:
      "NBA Top Shot sets ranked by average lock + burn squeeze across their editions — the drill-down companion to the per-edition squeeze board.",
    publicApi: true,
  },
  {
    slug: "squeeze",
    kind: "dataset",
    name: "Top Shot Lock-Rate Squeeze Board",
    description:
      "Ranks NBA Top Shot editions by effective supply (circulation minus locked minus burned). Refreshes hourly.",
    publicApi: true,
  },
  {
    slug: "squeeze-check",
    kind: "tool",
    name: "What's Liquid In Your Bag?",
    description:
      "Paste a Flow wallet and see how much of its Top Shot collection is actually liquid vs sitting in challenge-locked or burned editions.",
    publicApi: false,
  },
  {
    slug: "tc-report",
    kind: "tool",
    name: "Top Collector Report",
    description:
      "Full bag analytics for any Flow wallet — squeeze exposure, set completion, cross-collection footprint, rookie + WNBA coverage, and recent acquisitions.",
    publicApi: false,
  },
  {
    slug: "top-sales",
    kind: "dataset",
    name: "Top Sales — Whale Watch",
    description:
      "Ranks the biggest recent sales across NBA Top Shot, NFL All Day, Panini and Candy MLB, with the buyer and seller resolved to their marketplace username where known.",
    publicApi: true,
  },
  {
    slug: "topshot-pack-market",
    kind: "dataset",
    name: "NBA Top Shot Pack Market",
    description:
      "Ranks NBA Top Shot sealed packs by what they actually resell for on the secondary market vs their original drop price, from the complete on-chain sale history. Packs with 5+ secondary sales qualify.",
    publicApi: true,
  },
  {
    slug: "trophies",
    kind: "dataset",
    name: "The Trophy Room",
    description:
      "Ranks the rarest editions across every collection RPC tracks — every 1-of-1 and Ultimate-tier moment — by fair market value.",
    publicApi: true,
  },
  {
    slug: "underpriced-serials",
    kind: "dataset",
    name: "Underpriced #1s & Perfect Mints",
    description:
      "Lists NBA Top Shot headline serials (#1 mint and perfect mint) that are currently listed below their serial-FMV estimate, ranked by discount.",
    publicApi: true,
  },
]

const BY_SLUG: ReadonlyMap<string, InsightsBoard> = new Map(INSIGHTS_BOARDS.map((b) => [b.slug, b]))

/** Own-key lookup (a Map, so a crafted slug like "constructor" cannot hit a prototype member). */
export function getInsightsBoard(slug: string): InsightsBoard | undefined {
  return BY_SLUG.get(slug)
}

/**
 * The /insights hub as a schema.org CollectionPage whose mainEntity is an
 * ItemList of the boards it links (2026-10-14: the hub was the one major page
 * with no page-level JSON-LD). `liveSlugs` is the caller's list of boards that
 * are PUBLIC right now — pass lib/sitemap-data `INSIGHT_ROUTES`, which already
 * applies the launch flags — so a staged board is never advertised here.
 * Slugs without a registry entry are skipped, never named by their slug.
 */
export function insightsHubJsonLd(liveSlugs: readonly string[], siteUrl: string): Record<string, unknown> {
  const boards = liveSlugs.map((s) => BY_SLUG.get(s)).filter((b): b is InsightsBoard => !!b)
  const hubUrl = `${siteUrl}/insights`
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": hubUrl,
    url: hubUrl,
    name: "Rip Packs City Public Insights",
    description: "Free, no-signup boards on digital collectibles: supply, pack reality, scarcity, premiums, sales and wallet tools.",
    isPartOf: { "@type": "WebSite", name: "Rip Packs City", url: siteUrl },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: boards.length,
      itemListElement: boards.map((b, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: b.name,
        url: `${siteUrl}/insights/${b.slug}`,
      })),
    },
  }
}
