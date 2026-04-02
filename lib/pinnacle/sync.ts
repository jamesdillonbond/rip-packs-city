// ── Pinnacle Sync — Flowty → Supabase ────────────────────────────

import type { SupabaseClient } from "@supabase/supabase-js"
import { fetchPinnacleListings, parsePinnacleTraits, buildEditionKey, isLocked } from "./flowty"

/**
 * Sync Pinnacle editions from Flowty listings into pinnacle_editions.
 * Groups listings by edition_key and upserts one row per edition with the floor price.
 */
export async function syncPinnacleEditions(supabase: SupabaseClient): Promise<{
  upserted: number
  errors: string[]
}> {
  const errors: string[] = []
  const listings = await fetchPinnacleListings()

  // Group by edition key, track floor price per edition
  const editionMap = new Map<string, {
    set_name: string
    series_name: string
    characters: string
    studios: string
    variant: string
    edition_type: string
    royalty_codes: string
    is_chaser: boolean
    printing: string
    floor_price_usd: number | null
  }>()

  for (const listing of listings) {
    const rawTraits = listing.nftView?.traits?.traits ?? []
    if (rawTraits.length === 0) continue

    const traits = parsePinnacleTraits(rawTraits)
    const key = buildEditionKey(traits)
    const price = listing.orders?.[0]?.salePrice ?? null

    const existing = editionMap.get(key)
    const currentFloor = existing?.floor_price_usd ?? null
    const newFloor =
      price !== null && (currentFloor === null || price < currentFloor)
        ? price
        : currentFloor

    editionMap.set(key, {
      set_name: traits.setName,
      series_name: traits.seriesName,
      characters: traits.characters,
      studios: traits.studios,
      variant: traits.variant,
      edition_type: traits.editionType,
      royalty_codes: traits.royaltyCodes,
      is_chaser: traits.isChaser,
      printing: traits.printing,
      floor_price_usd: newFloor,
    })
  }

  // Upsert in batches
  const rows = Array.from(editionMap.entries()).map(([edition_key, data]) => ({
    edition_key,
    ...data,
    fmv_usd: null,
    fmv_confidence: "NO_DATA" as const,
    updated_at: new Date().toISOString(),
  }))

  if (rows.length > 0) {
    const { error } = await supabase
      .from("pinnacle_editions")
      .upsert(rows, { onConflict: "edition_key" })

    if (error) {
      errors.push(`editions upsert: ${error.message}`)
    }
  }

  return { upserted: rows.length, errors }
}

/**
 * Sync Pinnacle sales/listings from Flowty into pinnacle_sales.
 * Only inserts new records (won't overwrite existing sales).
 */
export async function syncPinnacleListings(supabase: SupabaseClient): Promise<{
  upserted: number
  errors: string[]
}> {
  const errors: string[] = []
  const listings = await fetchPinnacleListings()

  const rows: Array<{
    edition_key: string
    flow_id: string
    serial_number: number | null
    sale_price_usd: number
    payment_token: string
    sold_at: string
  }> = []

  for (const listing of listings) {
    const rawTraits = listing.nftView?.traits?.traits ?? []
    if (rawTraits.length === 0) continue

    const traits = parsePinnacleTraits(rawTraits)
    const key = buildEditionKey(traits)
    const price = listing.orders?.[0]?.salePrice
    if (price === undefined || price === null) continue

    const paymentToken =
      listing.orders?.[0]?.paymentTokenIdentifier ??
      "A.ead892083b3e2c6c.DapperUtilityCoin.Vault"

    rows.push({
      edition_key: key,
      flow_id: listing.flowNftId,
      serial_number: traits.serialNumber,
      sale_price_usd: price,
      payment_token: paymentToken,
      sold_at: new Date().toISOString(),
    })
  }

  if (rows.length > 0) {
    // Insert only new records — ignore conflicts on flow_id
    const { error } = await supabase
      .from("pinnacle_sales")
      .upsert(rows, { onConflict: "flow_id", ignoreDuplicates: true })

    if (error) {
      errors.push(`sales upsert: ${error.message}`)
    }
  }

  return { upserted: rows.length, errors }
}
