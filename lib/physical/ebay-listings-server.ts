/**
 * Server-side loader for the "Paper cards on eBay" module (prototype, NOT
 * mounted on any page).
 *
 * OFF unless every env var below is set — so merging this changes nothing
 * until Trevor approves the eBay Partner Network step (a revenue decision) and
 * eBay grants Buy API production access:
 *
 *   PHYSICAL_EBAY_LISTINGS=1
 *   EBAY_CLIENT_ID, EBAY_CLIENT_SECRET      (production keyset)
 *   EBAY_EPN_CAMPAIGN_ID                    (optional; without it links carry no commission)
 *
 * Freshness is a LICENCE rule, not a choice: eBay API License §8.1(c) —
 * "Displayed item listing information may not be more than six (6) hours older
 * than information displayed on the eBay Site." So the cache refreshes at 5 h and
 * the read refuses anything older than 6 h (ebay-listings-cached.ts) — the cache's
 * own expiry is not a ceiling, because it serves stale while it refreshes.
 *
 * Budget: Browse defaults to 5,000 calls/day and RPC has 2,368 indexable player
 * hubs (measured 2026-11-22). A crawler walking every hub on the 5 h refresh could
 * ask for ~11,400 calls/day, so every cache MISS bumps a durable site-wide
 * counter (EBAY_BROWSE_DAILY_CAP, default 4,000, never above 5,000) that fails
 * closed. Over the cap the section renders NOTHING — showing a listing older
 * than 6 h would breach §8.1(c). A refused or failed call THROWS inside the
 * cache so it is never stored (the marketplace-status lesson).
 *
 * Other licence rules this module keeps: §8.1(b)(2) eBay content "must be
 * visually isolated" from non-eBay content (own section); §9.6 never use eBay
 * content "to suggest or model prices" (asks are shown, never fed to any value);
 * §8.1(d) no derived statistics such as average selling price.
 *
 * Failure is silent by design: a failed read renders NOTHING (never "no
 * listings"), because the module makes no claim the page depends on.
 */
import { buildBrowseRequest, mapBrowseResponse, type EbayListing } from "./ebay-browse"

/** eBay API License §8.1(c): listing data shown may be at most 6 h old. A HARD ceiling, checked at read. */
export const LISTINGS_MAX_AGE_SECONDS = 6 * 60 * 60
/**
 * The cache refreshes before that ceiling (review finding 1, 2026-11-23). The cache is
 * stale-while-revalidate: past `revalidate` it still serves the old entry once while it
 * refreshes, and keeps serving it if the refresh throws. So freshness is enforced by the
 * read-time age check in ebay-listings-cached.ts, and refreshing at 5 h keeps a normal
 * visitor inside the 6 h ceiling.
 */
export const LISTINGS_REVALIDATE_SECONDS = 5 * 60 * 60

export type PaperListingsResult =
  | { status: "off" }
  | { status: "error" }
  /** `fetchedAt`: when eBay answered (ISO). The read-time age check keys on it. */
  | { status: "ok"; listings: EbayListing[]; affiliate: boolean; fetchedAt: string }

type Env = Record<string, string | undefined>

export function listingsEnabled(env: Env = process.env): boolean {
  return env.PHYSICAL_EBAY_LISTINGS === "1" && !!env.EBAY_CLIENT_ID && !!env.EBAY_CLIENT_SECRET
}

let tokenCache: { token: string; expiresAt: number } | null = null

/** Test hook. */
export function _resetTokenCache() {
  tokenCache = null
}

export async function getEbayAppToken(env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const now = Date.now()
  if (tokenCache && tokenCache.expiresAt - 60_000 > now) return tokenCache.token
  const basic = Buffer.from(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`).toString("base64")
  const res = await fetchImpl("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "https://api.ebay.com/oauth/api_scope",
    }).toString(),
    cache: "no-store",
  })
  if (!res.ok) return null
  const j = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!j.access_token) return null
  tokenCache = { token: j.access_token, expiresAt: now + (j.expires_in ?? 7200) * 1000 }
  return j.access_token
}

export async function fetchPaperListings(
  playerName: string,
  opts: { slug?: string; limit?: number; env?: Env; fetchImpl?: typeof fetch; allowCall?: () => Promise<boolean>; now?: () => number } = {},
): Promise<PaperListingsResult> {
  const env = opts.env ?? process.env
  const now = opts.now ?? Date.now
  const fetchImpl = opts.fetchImpl ?? fetch
  if (!listingsEnabled(env)) return { status: "off" }
  const name = playerName.trim()
  if (!name) return { status: "off" }
  try {
    if (opts.allowCall && !(await opts.allowCall())) return { status: "error" }
    const token = await getEbayAppToken(env, fetchImpl)
    if (!token) return { status: "error" }
    const req = buildBrowseRequest(
      {
        query: `${name} card`,
        limit: opts.limit ?? 8,
        campaignId: env.EBAY_EPN_CAMPAIGN_ID || undefined,
        referenceId: opts.slug,
      },
      token,
    )
    // no-store: the caller's cache owns freshness. A second, fetch-level 6 h cache under it
    // stacked two stale-while-revalidate windows (review finding 1).
    const res = await fetchImpl(req.url, { headers: req.headers, cache: "no-store" })
    if (!res.ok) return { status: "error" }
    const listings = mapBrowseResponse(await res.json())
      // A title that does not carry the player's surname is a keyword-match
      // stray (lots, other players) — drop it rather than show the wrong card.
      .filter((l) => titleMentions(l.title, name))
    return { status: "ok", listings, affiliate: listings.some((l) => l.isAffiliate), fetchedAt: new Date(now()).toISOString() }
  } catch {
    return { status: "error" }
  }
}

export function titleMentions(title: string, name: string): boolean {
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  const parts = fold(name).split(/\s+/).filter((p) => p.length > 1 && !/^(jr|sr|ii|iii|iv)\.?$/.test(p))
  const surname = parts[parts.length - 1]
  return !!surname && fold(title).includes(surname)
}

/** Site-wide daily cap on eBay calls; counts cache misses only. */
export function browseDailyCap(env: Env = process.env): number {
  const n = Number(env.EBAY_BROWSE_DAILY_CAP)
  return Number.isInteger(n) && n > 0 && n <= 5000 ? n : 4000
}
