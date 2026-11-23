/**
 * eBay Browse API — "Shop on eBay" active listings for a player
 * (prototype, NOT wired; no keys exist yet; nothing calls this).
 *
 * Stage 0 of the physical-cards route: answers the "<player> buy" searches RPC
 * already ranks for, without RPC claiming any value. Listings are ASKS — they
 * are never fed into a valuation (a-historical-minimum-sale-is-not-a-cost-to-buy
 * has the mirror-image lesson).
 *
 * Facts this relies on (eBay docs, read 2026-11-22):
 *  - GET /buy/browse/v1/item_summary/search, Application token, scope
 *    https://api.ebay.com/oauth/api_scope (client credentials).
 *  - limit max 200; offset a multiple of limit, < 10,000. Default buying
 *    option is FIXED_PRICE only.
 *  - itemAffiliateWebUrl is returned only when X-EBAY-C-ENDUSERCTX carries the
 *    affiliate campaign — commission requires using THAT url.
 *  - Buy APIs in production are Limited Release via eBay Partner Network.
 *  - Default Browse limit 5,000 calls/day → cache per player, refresh on a
 *    schedule, never per page view.
 * eBay API License (read 2026-11-22): listings shown may be at most 6 h old
 * (§8.1(c)); eBay content must be "visually isolated" from non-eBay content
 * (§8.1(b)(2)); eBay content may not be used "to suggest or model prices"
 * (§9.6). See ebay-listings-server.ts for how each is kept.
 */

export const EBAY_CATEGORY = {
  sportsCardSingles: "261328", // Sports Trading Cards > Trading Card Singles
  ccgIndividualCards: "183454", // Collectible Card Games > CCG Individual Cards (confirmed on ebay.com 2026-11-22)
} as const

export type BrowseSearchInput = {
  query: string // e.g. "Cooper Flagg rookie"
  categoryId?: string
  limit?: number // 1..200
  graded?: boolean // adds "psa OR bgs OR sgc OR cgc" when true
  maxPriceUsd?: number
  campaignId?: string // EPN campaign — enables itemAffiliateWebUrl
  referenceId?: string // EPN custom id, e.g. the player slug, for attribution
}

export type BrowseRequest = { url: string; headers: Record<string, string> }

const API = "https://api.ebay.com/buy/browse/v1/item_summary/search"

/** Builds the request. Token is passed in; this module never stores secrets. */
export function buildBrowseRequest(input: BrowseSearchInput, appToken: string): BrowseRequest {
  const limit = Math.min(Math.max(input.limit ?? 12, 1), 200)
  // eBay q syntax: space = AND, "(a,b)" = OR.
  const q = input.graded ? `${input.query} (psa,bgs,sgc,cgc)` : input.query
  const params = new URLSearchParams({
    q,
    category_ids: input.categoryId ?? EBAY_CATEGORY.sportsCardSingles,
    limit: String(limit),
  })
  const filters = ["buyingOptions:{FIXED_PRICE|AUCTION}"]
  if (input.maxPriceUsd != null) {
    filters.push(`price:[..${input.maxPriceUsd}]`, "priceCurrency:USD")
  }
  params.set("filter", filters.join(","))

  const headers: Record<string, string> = {
    Authorization: `Bearer ${appToken}`,
    "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
  }
  if (input.campaignId) {
    const ctx = [`affiliateCampaignId=${input.campaignId}`]
    if (input.referenceId) ctx.push(`affiliateReferenceId=${input.referenceId}`)
    headers["X-EBAY-C-ENDUSERCTX"] = ctx.join(",")
  }
  return { url: `${API}?${params.toString()}`, headers }
}

export type EbayListing = {
  itemId: string
  title: string
  priceUsd: number | null
  imageUrl: string | null
  href: string // affiliate url when present, else the plain item url
  isAffiliate: boolean
  buyingOptions: string[]
  endsAt: string | null
  condition: string | null
}

type RawSummary = {
  itemId?: string
  title?: string
  price?: { value?: string; currency?: string }
  image?: { imageUrl?: string }
  itemWebUrl?: string
  itemAffiliateWebUrl?: string
  buyingOptions?: string[]
  itemEndDate?: string
  condition?: string
}

/** Maps a search response; drops rows without an id, title or url. */
export function mapBrowseResponse(body: unknown): EbayListing[] {
  const rows = ((body as { itemSummaries?: RawSummary[] })?.itemSummaries ?? []) as RawSummary[]
  const out: EbayListing[] = []
  for (const r of rows) {
    const href = r.itemAffiliateWebUrl || r.itemWebUrl
    if (!r.itemId || !r.title || !href) continue
    const v = r.price?.currency === "USD" ? Number(r.price.value) : NaN
    out.push({
      itemId: r.itemId,
      title: r.title,
      priceUsd: Number.isFinite(v) ? v : null,
      imageUrl: r.image?.imageUrl ?? null,
      href,
      isAffiliate: Boolean(r.itemAffiliateWebUrl),
      buyingOptions: r.buyingOptions ?? [],
      endsAt: r.itemEndDate ?? null,
      condition: r.condition ?? null,
    })
  }
  return out
}

/** Calls/day for a refresh plan — keep well under the 5,000 default. */
export function dailyCallBudget(players: number, refreshesPerDay: number): number {
  return players * refreshesPerDay
}
