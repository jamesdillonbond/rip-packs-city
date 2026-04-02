import type { SupabaseClient } from "@supabase/supabase-js"
import {
  fetchPinnacleListings,
  parsePinnacleTraits,
  buildEditionKey,
} from "./flowty"

// ─── Sync editions from Flowty into pinnacle_editions ────────────────────────

export async function syncPinnacleEditions(
  supabase: SupabaseClient
): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = []

  let listings
  try {
    listings = await fetchPinnacleListings()
  } catch (err) {
    return { upserted: 0, errors: [`Fetch failed: ${String(err)}`] }
  }

  // Group listings by edition_key and pick the lowest floor price
  const editionMap = new Map<
    string,
    {
      edition_key: string
      set_name: string | null
      series_name: string | null
      characters: string | null
      variant: string | null
      edition_type: string | null
      studios: string | null
      royalty_codes: string | null
      is_chaser: boolean
      printing: string | null
      event_name: string | null
      floor_price_usd: number | null
      fmv_usd: number | null
      fmv_confidence: string
      listings_count: number
    }
  >()

  for (const listing of listings) {
    const traits = parsePinnacleTraits(
      listing.nftView?.traits?.traits ?? []
    )
    const key = buildEditionKey(traits)
    const price =
      listing.orders?.[0]?.salePrice ?? null

    const existing = editionMap.get(key)
    if (existing) {
      existing.listings_count += 1
      if (
        price !== null &&
        (existing.floor_price_usd === null ||
          price < existing.floor_price_usd)
      ) {
        existing.floor_price_usd = price
      }
    } else {
      editionMap.set(key, {
        edition_key: key,
        set_name: traits.setName,
        series_name: traits.seriesName,
        characters: traits.characters,
        variant: traits.variant,
        edition_type: traits.editionType,
        studios: traits.studios,
        royalty_codes: traits.royaltyCodes
          ? traits.royaltyCodes.replace(/^\[/, "").replace(/\]$/, "")
          : null,
        is_chaser: traits.isChaser,
        printing: traits.printing,
        event_name: traits.eventName,
        floor_price_usd: price,
        fmv_usd: null,
        fmv_confidence: "NO_DATA",
        listings_count: 1,
      })
    }
  }

  const rows = Array.from(editionMap.values())
  if (rows.length === 0) {
    return { upserted: 0, errors }
  }

  const { error } = await supabase
    .from("pinnacle_editions")
    .upsert(rows, { onConflict: "edition_key" })

  if (error) {
    errors.push(`Edition upsert error: ${error.message}`)
    return { upserted: 0, errors }
  }

  return { upserted: rows.length, errors }
}

// ─── Sync individual listing sales into pinnacle_sales ───────────────────────

export async function syncPinnacleListings(
  supabase: SupabaseClient
): Promise<{ upserted: number; errors: string[] }> {
  const errors: string[] = []

  let listings
  try {
    listings = await fetchPinnacleListings()
  } catch (err) {
    return { upserted: 0, errors: [`Fetch failed: ${String(err)}`] }
  }

  const rows: Array<{
    edition_key: string
    sale_price_usd: number
    serial_number: number | null
    seller_address: string | null
    buyer_address: string | null
    sold_at: string
  }> = []

  for (const listing of listings) {
    const traits = parsePinnacleTraits(
      listing.nftView?.traits?.traits ?? []
    )
    const key = buildEditionKey(traits)
    const price = listing.orders?.[0]?.salePrice

    if (price === undefined || price === null) continue

    rows.push({
      edition_key: key,
      sale_price_usd: price,
      serial_number: traits.serialNumber,
      seller_address: null,
      buyer_address: null,
      sold_at: new Date().toISOString(),
    })
  }

  if (rows.length === 0) {
    return { upserted: 0, errors }
  }

  // Insert only new sales — ignore conflicts on duplicate entries
  const { error } = await supabase
    .from("pinnacle_sales")
    .upsert(rows, {
      onConflict: "edition_key,sale_price_usd,serial_number,sold_at",
      ignoreDuplicates: true,
    })

  if (error) {
    errors.push(`Sales upsert error: ${error.message}`)
    return { upserted: 0, errors }
  }

  return { upserted: rows.length, errors }
}
