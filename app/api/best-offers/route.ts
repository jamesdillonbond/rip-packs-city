import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

// Edition-level top standing offer, sourced from the live Top Shot offer feed.
// Primary source is edition_offers (the broad untagged /api/cron/offers-sweep
// cache, ~all marketplace editions); badge_editions.highest_offer is the
// fallback for editions the sweep hasn't reached yet. Both are the same
// `highestOffer` GQL field the moment / edition detail pages read via
// get_edition_high_offer, so the value returned here is the true MAX standing
// bid for the edition.
//
// These sources only carry Top Shot offers, so non-TS editions (and TS editions
// Top Shot does not publish an offer for) return bestOffer: null — the
// collection grid already renders a dash for null.

type BestOfferResult = {
  momentId: string
  editionKey: string | null
  bestOffer: number | null
  bestOfferSource: "Top Shot Edition" | "Top Shot Serial" | "Flowty Serial" | null
  bestOfferType: "edition" | "serial" | null
}

const CHUNK = 500 // PostgREST URL cap on .in() lists

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const momentIds = Array.isArray(body.momentIds)
      ? body.momentIds.map((x: unknown) => String(x))
      : []

    const editionKeys = Array.isArray(body.editionKeys) ? body.editionKeys : []
    // Per-moment serials, aligned by index with momentIds (optional — older
    // callers omit it; then only the edition-grain leg is used). Item 1.
    const serials: Array<number | null> = Array.isArray(body.serials)
      ? body.serials.map((s: unknown) => {
          const n = Number(s)
          return Number.isFinite(n) && n > 0 ? n : null
        })
      : []
    const collectionId = typeof body.collectionId === "string" ? body.collectionId : null

    // No collection or no keys → nothing to look up; return null offers.
    const emptyResults: BestOfferResult[] = momentIds.map((momentId: string, index: number) => ({
      momentId,
      editionKey: editionKeys[index] ?? null,
      bestOffer: null,
      bestOfferSource: null,
      bestOfferType: null,
    }))

    if (!collectionId || !momentIds.length) {
      return NextResponse.json({ results: emptyResults })
    }

    // Distinct, non-empty edition keys to look up.
    const distinctKeys = Array.from(
      new Set(
        editionKeys
          .map((k: unknown) => (typeof k === "string" ? k.trim() : ""))
          .filter((k: string) => k.length > 0)
      )
    ) as string[]

    if (!distinctKeys.length) {
      return NextResponse.json({ results: emptyResults })
    }

    const supabase: any = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // external_id is the integer on-chain pair "setID:playID" for Top Shot —
    // the same string the collection grid stores as editionKey. Read the broad
    // edition_offers cache first; fall back to badge_editions for any key the
    // offers-sweep hasn't populated yet.
    const offerByKey = new Map<string, number>()

    async function harvest(table: "edition_offers" | "badge_editions", keys: string[]) {
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK)
        const { data, error } = await supabase
          .from(table)
          .select("external_id, highest_offer")
          .eq("collection_id", collectionId)
          .in("external_id", slice)
          .gt("highest_offer", 0)
        if (error) throw new Error(error.message)
        for (const row of data ?? []) {
          const key = String(row.external_id)
          const offer = Number(row.highest_offer)
          if (!Number.isFinite(offer) || offer <= 0) continue
          const prev = offerByKey.get(key)
          if (prev == null || offer > prev) offerByKey.set(key, offer)
        }
      }
    }

    // Serial-grain offers (Item 1): a single open offer targeting one exact
    // serial can legitimately exceed the edition-wide offer (special / area-code
    // / birthday serials). Keyed `${external_id}|${serial}`. Only relevant for
    // Top Shot, where the `offers` table lives; get_serial_offers returns
    // nothing for other collections. Best-effort — a failure here must not drop
    // the edition-grain answer.
    const serialOfferByKey = new Map<string, number>()
    try {
      await harvest("edition_offers", distinctKeys)
      const missing = distinctKeys.filter((k) => !offerByKey.has(k))
      if (missing.length) await harvest("badge_editions", missing)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "offers query failed", results: emptyResults },
        { status: 500 }
      )
    }

    const hasAnySerial = serials.some((s) => s != null)
    if (hasAnySerial) {
      try {
        const { data, error } = await supabase.rpc("get_serial_offers", {
          p_collection_id: collectionId,
          p_external_ids: distinctKeys,
        })
        if (!error && Array.isArray(data)) {
          for (const row of data) {
            const ext = String(row.external_id)
            const serial = Number(row.serial_number)
            const amt = Number(row.offer_amount_usd)
            if (!Number.isFinite(serial) || !Number.isFinite(amt) || amt <= 0) continue
            const k = `${ext}|${serial}`
            const prev = serialOfferByKey.get(k)
            if (prev == null || amt > prev) serialOfferByKey.set(k, amt)
          }
        } else if (error) {
          console.warn("[best-offers] get_serial_offers error:", error.message)
        }
      } catch (e) {
        console.warn("[best-offers] get_serial_offers threw:", e instanceof Error ? e.message : String(e))
      }
    }

    const results: BestOfferResult[] = momentIds.map((momentId: string, index: number) => {
      const editionKey = editionKeys[index] ?? null
      const key = typeof editionKey === "string" ? editionKey.trim() : ""
      const editionOffer = key ? offerByKey.get(key) : undefined
      const serial = serials[index] ?? null
      const serialOffer = key && serial != null ? serialOfferByKey.get(`${key}|${serial}`) : undefined

      // Eligible-max: the single highest offer this serial qualifies for. No floor.
      let bestOffer: number | null = null
      let bestOfferSource: BestOfferResult["bestOfferSource"] = null
      let bestOfferType: BestOfferResult["bestOfferType"] = null
      if (editionOffer != null && editionOffer > 0) {
        bestOffer = editionOffer
        bestOfferSource = "Top Shot Edition"
        bestOfferType = "edition"
      }
      if (serialOffer != null && serialOffer > 0 && (bestOffer == null || serialOffer > bestOffer)) {
        bestOffer = serialOffer
        bestOfferSource = "Top Shot Serial"
        bestOfferType = "serial"
      }

      return {
        momentId,
        editionKey,
        bestOffer,
        bestOfferSource,
        bestOfferType,
      }
    })

    return NextResponse.json({ results })
  } catch (e) {
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "best-offers failed",
        results: [],
      },
      { status: 500 }
    )
  }
}
