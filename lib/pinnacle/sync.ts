import type { SupabaseClient } from "@supabase/supabase-js"
import {
  fetchPinnacleListings,
  parsePinnacleTraits,
  buildEditionKey,
  getSerial,
} from "./flowty"

// ─── Sync editions ───────────────────────────────────────────────────────────
// Fetches all Flowty listings and upserts unique editions into pinnacle_editions.

export async function syncPinnacleEditions(supabase: SupabaseClient) {
  const listings = await fetchPinnacleListings()
  const errors: string[] = []

  // Deduplicate by edition key — keep the first occurrence
  const editionMap = new Map<string, Record<string, unknown>>()

  for (const listing of listings) {
    try {
      const traits = parsePinnacleTraits(listing.nftView.traits.traits)
      const editionKey = buildEditionKey(traits)

      if (editionMap.has(editionKey)) continue

      // Strip brackets from Studios for clean storage
      const studio = traits.Studios.replace(/^\[|\]$/g, "")

      editionMap.set(editionKey, {
        id: editionKey,
        external_id: listing.nftView.id,
        character_name: traits.Characters.replace(/^\[|\]$/g, ""),
        franchise: studio,
        set_name: traits.SetName,
        royalty_code: traits.RoyaltyCodes.replace(/^\[|\]$/g, ""),
        variant_type: traits.Variant,
        edition_type: traits.EditionType,
        printing: Number(traits.Printing) || 1,
        is_serialized: traits.SerialNumber !== null,
        is_chaser: traits.IsChaser === "true",
        updated_at: new Date().toISOString(),
      })
    } catch (err) {
      errors.push(`Edition parse error: ${(err as Error).message}`)
    }
  }

  const rows = Array.from(editionMap.values())

  if (rows.length === 0) {
    return { editions_upserted: 0, errors }
  }

  const { error } = await supabase
    .from("pinnacle_editions")
    .upsert(rows, { onConflict: "id" })

  if (error) {
    errors.push(`Edition upsert error: ${error.message}`)
  }

  return { editions_upserted: rows.length, errors }
}

// ─── Sync listings (sales) ───────────────────────────────────────────────────
// Fetches Flowty listings and inserts new sales into pinnacle_sales.
// Uses listingResourceID as the sale ID to avoid duplicates.

export async function syncPinnacleListings(supabase: SupabaseClient) {
  const listings = await fetchPinnacleListings()
  const errors: string[] = []
  const rows: Record<string, unknown>[] = []

  for (const listing of listings) {
    try {
      if (!listing.orders || listing.orders.length === 0) continue

      const traits = parsePinnacleTraits(listing.nftView.traits.traits)
      const editionKey = buildEditionKey(traits)
      const order = listing.orders[0]
      const serial = getSerial(traits)

      rows.push({
        id: order.listingResourceID,
        edition_id: editionKey,
        nft_id: listing.nftView.id,
        sale_price_usd: order.salePrice,
        serial_number: serial,
        sold_at: new Date().toISOString(),
        source: "flowty",
      })
    } catch (err) {
      errors.push(`Listing parse error: ${(err as Error).message}`)
    }
  }

  if (rows.length === 0) {
    return { listings_upserted: 0, errors }
  }

  // Use upsert with ignoreDuplicates to avoid overwriting existing records
  const { error } = await supabase
    .from("pinnacle_sales")
    .upsert(rows, { onConflict: "id", ignoreDuplicates: true })

  if (error) {
    errors.push(`Sales upsert error: ${error.message}`)
  }

  return { listings_upserted: rows.length, errors }
}
