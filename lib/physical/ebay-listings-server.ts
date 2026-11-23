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
 * than information displayed on the eBay Site." So listings are cached 6 h, no
 * longer.
 *
 * Budget: Browse defaults to 5,000 calls/day and RPC has 2,368 indexable player
 * hubs (measured 2026-11-22). A crawler walking every hub on a 6 h cache could
 * ask for ~9,500 calls/day, so every cache MISS bumps a durable site-wide
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

/** eBay API License §8.1(c): listing data shown may be at most 6 h old. */
export const LISTINGS_REVALIDATE_SECONDS = 6 * 60 * 60

export type PaperListingsResult =
  | { status: "off" }
  | { status: "error" }
  | { status: "ok"; listings: EbayListing[]; affiliate: boolean }

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
  opts: { slug?: string; limit?: number; env?: Env; fetchImpl?: typeof fetch; allowCall?: () => Promise<boolean> } = {},
): Promise<PaperListingsResult> {
  const env = opts.env ?? process.env
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
    const res = await fetchImpl(req.url, {
      headers: req.headers,
      next: { revalidate: LISTINGS_REVALIDATE_SECONDS },
    } as RequestInit)
    if (!res.ok) return { status: "error" }
    const listings = mapBrowseResponse(await res.json())
      // A title that does not carry the player's surname is a keyword-match
      // stray (lots, other players) — drop it rather than show the wrong card.
      .filter((l) => titleMentions(l.title, name))
    return { status: "ok", listings, affiliate: listings.some((l) => l.isAffiliate) }
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
