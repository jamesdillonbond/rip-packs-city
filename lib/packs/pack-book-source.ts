// lib/packs/pack-book-source.ts — SERVER ONLY (reads via the service-role client).
//
// Which sealed-pack ASK BOOK the pack surfaces read: Dapper Studio's aggregation (the default,
// ~5-min fresh) or Atlas's DistributionService book (the fallback, a complete walk every ~15-30
// min). Added 2026-10-31 for known-issue #218: Studio's whole pack index froze 10-29 ~8 AM PT
// and every pack surface kept serving that day's book. Atlas — the backend nbatopshot.com and
// nflallday.com call — kept listing live (dist 8905's newest listing 3:54 PM PT on 10-31 while
// Studio still said 10-29).
//
// THE RULE (chooseBookSource, pure, tested): use Atlas only when its book is COMPLETE and recent
// AND it knows a listing Studio does not — Atlas's newest listing is more than STUDIO_LAG_MS
// newer than Studio's newest. Studio's newest listing is read from its own sales mirror
// (`*_pack_sales_history.block_time` is the LISTING's creation block), so both sides are the
// same quantity from two indexers. When Studio recovers, its mirror catches up within minutes
// and the rule hands the book back. Golazos is not in Atlas's pack product set: Studio only.
//
// ⚠ FAIL TOWARD STUDIO, never toward empty. A failed Atlas read, an incomplete first pass or a
// stale Atlas book returns the Studio book unchanged — whose freeze the Sniper and pack pages
// already state ("Asks NOT live", lib/packs/pack-deals.ts). This module never turns a failed
// read into "no packs listed".
//
// Kept out of live-pack-listings.ts on purpose: a client component imports that module (for
// packNftTypeName), and this one imports the service-role client.

import { supabaseAdmin } from "@/lib/supabase"
import { normalizePackRetailPrice } from "@/lib/packs/normalize-retail-price"
import {
  classifyPackType,
  fetchLivePackListings,
  seriesLabelFromStartTime,
  sortPackListings,
  type ListingCollectionSlug,
  type PackListing,
} from "@/lib/packs/live-pack-listings"

export type PackBookSource = "studio" | "atlas"

export type AtlasBookRow = {
  dist_id: string
  dist_uuid: string | null
  title: string | null
  tier: string | null
  image_url: string | null
  pack_type: string | null
  dist_type: string | null
  slots: number | null
  retail_usd: number | null
  start_time: string | null
  low_ask_usd: number | null
  num_listed: number | null
  latest_listed_at: string | null
  observed_at: string | null
}

export type AtlasBook = {
  product: "nba" | "nfl"
  complete_at: string | null
  complete_pass_started_at: string | null
  dists_in_book: number | null
  atlas_newest_listing_at: string | null
  studio_newest_listing_at: string | null
  rows: AtlasBookRow[]
}

/** Atlas must know a listing this much newer than Studio's newest before Studio is called frozen. */
export const STUDIO_LAG_MS = 2 * 60 * 60 * 1000
/** An Atlas book older than this (its last COMPLETE pass) is not used. */
export const ATLAS_BOOK_MAX_AGE_MS = 2 * 60 * 60 * 1000

export type SourceDecision = { source: PackBookSource; reason: string }

export function atlasProductFor(collection: ListingCollectionSlug): "nba" | "nfl" | null {
  if (collection === "nba-top-shot") return "nba"
  if (collection === "nfl-all-day") return "nfl"
  return null
}

const ms = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : NaN
}

/** Pure. Studio unless Atlas is complete, recent, and ahead of Studio by more than STUDIO_LAG_MS. */
export function chooseBookSource(book: AtlasBook | null, nowMs: number): SourceDecision {
  if (!book) return { source: "studio", reason: "atlas_unread" }
  const completeAt = ms(book.complete_at)
  if (!Number.isFinite(completeAt)) return { source: "studio", reason: "atlas_incomplete" }
  if (nowMs - completeAt > ATLAS_BOOK_MAX_AGE_MS) return { source: "studio", reason: "atlas_stale" }
  if (!Array.isArray(book.rows) || book.rows.length === 0) return { source: "studio", reason: "atlas_empty" }
  const atlasNewest = ms(book.atlas_newest_listing_at)
  if (!Number.isFinite(atlasNewest)) return { source: "studio", reason: "atlas_no_listing_time" }
  const studioNewest = ms(book.studio_newest_listing_at)
  if (!Number.isFinite(studioNewest) || atlasNewest - studioNewest > STUDIO_LAG_MS) {
    return { source: "atlas", reason: "studio_behind" }
  }
  return { source: "studio", reason: "studio_current" }
}

/** Pure. One Atlas book row → the PackListing shape every pack surface reads. Null = not a usable ask. */
export function atlasRowToListing(r: AtlasBookRow): PackListing | null {
  const ask = Number(r.low_ask_usd)
  if (!r.dist_id || !Number.isFinite(ask) || ask <= 0) return null
  const slotsKnown = typeof r.slots === "number" && r.slots > 0
  const slots = slotsKnown ? (r.slots as number) : 1
  const retailPrice = normalizePackRetailPrice(r.retail_usd ?? 0)
  const title = r.title ?? `Pack #${r.dist_id}`
  const startTime = r.start_time ?? ""
  return {
    packListingId: r.dist_uuid ?? r.dist_id,
    distId: String(r.dist_id),
    title,
    tier: r.tier ?? "common",
    imageUrl: r.image_url ?? "",
    momentsPerPack: slots,
    retailPrice,
    lowestAsk: ask,
    startTime,
    // Atlas carries the real count; Studio's field was structurally 1 (see PackListing).
    listingCount: typeof r.num_listed === "number" && r.num_listed > 0 ? r.num_listed : 1,
    packType: classifyPackType(title, slots, retailPrice, r.pack_type),
    seriesLabel: seriesLabelFromStartTime(startTime),
    liveFields: { title: r.title != null, tier: r.tier != null, image: Boolean(r.image_url), slots: slotsKnown },
  }
}

const atlasMemo = new Map<string, { book: AtlasBook | null; expiresAt: number }>()
const ATLAS_MEMO_MS = 60 * 1000

/** Reads the Atlas book. Returns null on ANY failure (the caller then keeps Studio). */
export async function readAtlasBook(product: "nba" | "nfl", opts: { force?: boolean } = {}): Promise<AtlasBook | null> {
  if (!opts.force) {
    const hit = atlasMemo.get(product)
    if (hit && hit.expiresAt > Date.now()) return hit.book
  }
  let book: AtlasBook | null = null
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (supabaseAdmin as any).rpc("atlas_pack_book", { p_product: product })
    if (!res?.error && res?.data && typeof res.data === "object" && Array.isArray(res.data.rows)) {
      book = res.data as AtlasBook
    }
  } catch {
    book = null
  }
  atlasMemo.set(product, { book, expiresAt: Date.now() + ATLAS_MEMO_MS })
  return book
}

export type PackBook = {
  listings: PackListing[]
  cached: boolean
  source: PackBookSource
  reason: string
  /** For an Atlas book: when its last complete walk finished. Null for Studio. */
  asOf: string | null
}

/**
 * The pack ask book for a collection, from whichever source is live. Throws only when the
 * Studio read throws AND Atlas cannot stand in — a failed read is never an empty book.
 */
export async function fetchPackBook(
  collection: ListingCollectionSlug,
  opts: { force?: boolean } = {},
): Promise<PackBook> {
  const product = atlasProductFor(collection)
  if (!product) {
    const s = await fetchLivePackListings(collection, opts)
    return { ...s, source: "studio", reason: "no_atlas_product", asOf: null }
  }
  const atlas = await readAtlasBook(product, opts)
  const decision = chooseBookSource(atlas, Date.now())
  if (decision.source === "atlas" && atlas) {
    const listings = atlas.rows.map(atlasRowToListing).filter((l): l is PackListing => l !== null)
    if (listings.length > 0) {
      return { listings: sortPackListings(listings), cached: false, source: "atlas", reason: decision.reason, asOf: atlas.complete_at }
    }
  }
  try {
    const s = await fetchLivePackListings(collection, opts)
    return { ...s, source: "studio", reason: decision.reason, asOf: null }
  } catch (e) {
    // Studio threw. Atlas may still stand in if its book is complete and recent, whatever the
    // lag comparison said (a throwing Studio is not a current Studio).
    const fallback = chooseBookSource(
      atlas ? { ...atlas, studio_newest_listing_at: null } : null,
      Date.now(),
    )
    if (fallback.source === "atlas" && atlas) {
      const listings = atlas.rows.map(atlasRowToListing).filter((l): l is PackListing => l !== null)
      if (listings.length > 0) {
        return { listings: sortPackListings(listings), cached: false, source: "atlas", reason: "studio_read_failed", asOf: atlas.complete_at }
      }
    }
    throw e
  }
}
