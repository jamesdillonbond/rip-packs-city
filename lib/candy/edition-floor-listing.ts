// lib/candy/edition-floor-listing.ts
//
// Candy MLB (Top Shot parity, 2026-10-26): the edition page's outbound
// marketplace CTA. Top Shot / All Day / Golazos link the edition on
// dapper.market; Panini links its own marketplace page. Magic Eden has no
// per-EDITION page for a Candy card — it is deep-linkable per MINT only
// (MARKETPLACE_MOMENT_URL_TEMPLATES["candy-mlb"]) — so the honest edition-grain
// link is the CHEAPEST LIVE LISTING of this edition: the copy a buyer would
// actually click through to.
//
// "Live" = the listings sweep re-saw it in the last CANDY_LISTING_CONFIRMED_HOURS
// (the same 12 h window candy_listing_floor.confirmed_* and the market bundle's
// "% Listed" use). An is_active row the sweep stopped re-seeing is NOT live —
// measured 10-26: an edition held 3 is_active rows, 2 last re-seen 10-12 and
// 08-16. A failed read returns ok:false and the CTA hides; it never links a
// listing we could not confirm.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import { marketplaceMomentUrl } from "@/lib/collections"

export const CANDY_LISTING_CONFIRMED_HOURS = 12

export interface CandyFloorListing {
  mint: string
  priceUsd: number
  url: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
type FloorRows = Array<{ token_mint: string | null; price_usd: unknown }>

export async function fetchCandyFloorListing(
  editionId: string,
  injected?: Db,
): Promise<{ listing: CandyFloorListing | null; ok: boolean }> {
  const db: Db = injected ?? supabaseAdmin
  const since = new Date(Date.now() - CANDY_LISTING_CONFIRMED_HOURS * 3600_000).toISOString()
  try {
    const { data, error } = await withQueryDeadline<FloorRows>(
      db.from("candy_listings")
        .select("token_mint,price_usd")
        .eq("edition_id", editionId)
        .eq("is_active", true)
        .gt("price_usd", 0)
        .gte("last_seen_at", since)
        .or(`expiry.is.null,expiry.gt.${new Date().toISOString()}`)
        .order("price_usd", { ascending: true })
        .order("token_mint", { ascending: true })
        .limit(1),
      "edition/candy-floor-listing",
      apiReadTimeoutMs(),
    )
    if (error) return { listing: null, ok: false }
    const row = (data ?? [])[0]
    const price = row ? Number(row.price_usd) : NaN
    if (!row || !row.token_mint || !Number.isFinite(price) || price <= 0) return { listing: null, ok: true }
    const url = marketplaceMomentUrl("candy-mlb", row.token_mint)
    if (!url) return { listing: null, ok: true }
    return { listing: { mint: row.token_mint, priceUsd: price, url }, ok: true }
  } catch {
    return { listing: null, ok: false }
  }
}
