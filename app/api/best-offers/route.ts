import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { safeApiError } from "@/lib/api-error"

// Edition-level top standing offer, sourced from the live Top Shot offer feed.
// Primary source is edition_offers (the broad untagged /api/cron/offers-sweep
// cache, ~all marketplace editions); badge_editions.highest_offer is the
// fallback for editions the sweep hasn't reached yet. Both are the same
// `highestOffer` GQL field the moment / edition detail pages read via
// get_edition_high_offer, so the value returned here is the true MAX standing
// bid for the edition.
//
// Those two sources only carry Top Shot offers. For the other Dapper-native Flow
// collections (AllDay / UFC / Golazos) the standing bids live in the on-chain
// DapperOffersV2 feed `marketplace_offers` (keyed by nft_id = the moment_id,
// priced in DUC ~= USD), so a per-moment leg reads that for non-Top-Shot
// collections. The Top Shot path is untouched — it already has the richer
// edition + serial sources, and folding marketplace_offers into it would change
// established values, so the leg is skipped for Top Shot. Editions with no
// standing bid in any source still return bestOffer: null (the grid renders a
// dash).

const TOPSHOT_COLLECTION_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

type BestOfferResult = {
  momentId: string
  editionKey: string | null
  bestOffer: number | null
  bestOfferSource: "Top Shot Edition" | "Top Shot Serial" | "Flowty Serial" | "Dapper Offer" | null
  bestOfferType: "edition" | "serial" | null
  /**
   * Hours since the winning bid was last CONFIRMED, or `null` when this leg cannot
   * answer that. Added 2026-08-29.
   *
   * ⚠ TWO OF THE FOUR LEGS ARE STRUCTURALLY UNDATABLE, and they must render UNMARKED
   * rather than be forced into a number:
   *   - `get_serial_offers` returns `(external_id, serial_number, offer_amount_usd)` —
   *     no timestamp at all.
   *   - `marketplace_offers.created_at` is when the OFFER WAS MADE, not when we last
   *     checked it. Labelling that "unconfirmed 90d" would be a NEW false claim about
   *     a long-standing bid — the same trap the deals board hit with All Day's
   *     `floor_ask_listed_at`, where a listed-at was nearly relabelled a verified-at.
   * So `null` here means UNKNOWN, and unknown must never render as fresh either.
   */
  bestOfferAgeHours: number | null
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
      bestOfferAgeHours: null,
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

    // NB: an empty distinctKeys list is NOT a short-circuit. The edition- and
    // serial-grain legs below no-op harmlessly on empty keys, but the
    // moment-grain marketplace_offers leg is keyed by momentId (not editionKey),
    // so a non-Top-Shot caller that sends only momentIds still has live standing
    // bids to surface. Returning early here would drop them.

    const supabase: any = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // external_id is the integer on-chain pair "setID:playID" for Top Shot —
    // the same string the collection grid stores as editionKey. Read the broad
    // edition_offers cache first; fall back to badge_editions for any key the
    // offers-sweep hasn't populated yet.
    // 🚨 THE PREFERENCE ORDER WAS WRONG FOR ALL DAY, AND IT IS A MEASUREMENT.
    // This used to read `edition_offers` first and consult `badge_editions` only for
    // keys the sweep had MISSED — on the premise, written into the comment above, that
    // the sweep is the fresher source. True for Top Shot (33.0 h median vs 111.7 h);
    // FALSE for All Day, which has a dedicated `allday-badge-low-ask-refresh` running
    // green every hour while `offers-sweep` barely reaches it: **edition_offers 168.5 h
    // median vs badge_editions 1.0 h**. Of 2,052 All Day keys present in BOTH, **1,925
    // (94%) had a badge row at least a day fresher**, and **137 of those disagreed on
    // the value** — so the grid showed a week-old bid while an hour-old one said
    // something else.
    // ⚠ THE FIX IS A RULE, NOT A PER-COLLECTION SWITCH: prefer the row we CONFIRMED
    // most recently. That adapts on its own if either feed's health flips again, which
    // a hardcoded "All Day prefers badges" would not.
    // ⚠ AND IT IS NOT "TAKE THE HIGHER BID" ANY MORE, across tables. Within one table
    // the max still wins (two rows for one key are both current). Across tables the
    // fresher wins even when it is LOWER — a bid that was withdrawn is not beaten by a
    // stale memory of it.
    type OfferHit = { offer: number; at: number | null }
    const offerByKey = new Map<string, OfferHit>()

    /** Prefer the fresher row; fall back to the higher bid when neither is datable. */
    function considerOffer(key: string, hit: OfferHit) {
      const prev = offerByKey.get(key)
      if (prev == null) { offerByKey.set(key, hit); return }
      if (hit.at != null && prev.at != null) {
        if (hit.at > prev.at) offerByKey.set(key, hit)
        else if (hit.at === prev.at && hit.offer > prev.offer) offerByKey.set(key, hit)
        return
      }
      // One side undatable: a KNOWN confirmation time beats an unknown one.
      if (hit.at != null && prev.at == null) { offerByKey.set(key, hit); return }
      if (hit.at == null && prev.at != null) return
      if (hit.offer > prev.offer) offerByKey.set(key, hit)
    }

    async function harvest(table: "edition_offers" | "badge_editions", keys: string[]) {
      for (let i = 0; i < keys.length; i += CHUNK) {
        const slice = keys.slice(i, i + CHUNK)
        const { data, error } = await supabase
          .from(table)
          .select("external_id, highest_offer, updated_at")
          .eq("collection_id", collectionId)
          .in("external_id", slice)
          .gt("highest_offer", 0)
        if (error) throw new Error(error.message)
        for (const row of data ?? []) {
          const key = String(row.external_id)
          const offer = Number(row.highest_offer)
          if (!Number.isFinite(offer) || offer <= 0) continue
          // `null` when the timestamp is missing or unparseable — passed through, never
          // coalesced to now(), which would publish an unknown age as a fresh one.
          const t = row.updated_at ? Date.parse(String(row.updated_at)) : NaN
          considerOffer(key, { offer, at: Number.isNaN(t) ? null : t })
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
      // ⚠ BOTH TABLES OVER ALL KEYS NOW — `badge_editions` is no longer a gap-filler.
      // It cannot be: the freshness comparison above only means something if both rows
      // are actually read. This is one extra chunked read per request over the keys
      // already batched at CHUNK apiece; the previous shape queried the same rows for
      // every key the sweep had missed anyway.
      await harvest("edition_offers", distinctKeys)
      await harvest("badge_editions", distinctKeys)
    } catch (e) {
      return NextResponse.json(
        // Shape-preserving: the caller reads `results`, so only the message is
        // classified. safeApiError does not log, hence the explicit log.
        { ...safeApiError(e, "Offers aren't available right now."), results: emptyResults },
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

    // Moment-grain DapperOffersV2 offers for the non-Top-Shot Flow collections
    // (AllDay / UFC / Golazos): marketplace_offers is keyed by nft_id = the
    // moment_id, priced in DUC (~= USD), offer_state='LISTED' == a live standing
    // bid. Skipped for Top Shot (its edition/serial sources above are richer and
    // authoritative). Best-effort — a failure here must not drop the answer.
    const momentOfferById = new Map<string, number>()
    if (collectionId !== TOPSHOT_COLLECTION_UUID) {
      try {
        for (let i = 0; i < momentIds.length; i += CHUNK) {
          const slice = momentIds.slice(i, i + CHUNK)
          const { data, error } = await supabase
            .from("marketplace_offers")
            .select("nft_id, offer_price")
            .eq("collection_id", collectionId)
            .eq("offer_state", "LISTED")
            .eq("currency", "DUC")
            .gt("offer_price", 0)
            .in("nft_id", slice)
          if (error) {
            console.warn("[best-offers] marketplace_offers error:", error.message)
            break
          }
          for (const row of data ?? []) {
            const id = String(row.nft_id)
            const amt = Number(row.offer_price)
            if (!Number.isFinite(amt) || amt <= 0) continue
            const prev = momentOfferById.get(id)
            if (prev == null || amt > prev) momentOfferById.set(id, amt)
          }
        }
      } catch (e) {
        console.warn("[best-offers] marketplace_offers threw:", e instanceof Error ? e.message : String(e))
      }
    }

    const results: BestOfferResult[] = momentIds.map((momentId: string, index: number) => {
      const editionKey = editionKeys[index] ?? null
      const key = typeof editionKey === "string" ? editionKey.trim() : ""
      const editionHit = key ? offerByKey.get(key) : undefined
      const editionOffer = editionHit?.offer
      const serial = serials[index] ?? null
      const serialOffer = key && serial != null ? serialOfferByKey.get(`${key}|${serial}`) : undefined
      const momentOffer = momentOfferById.get(momentId)

      // Eligible-max: the single highest offer this serial qualifies for. No floor.
      let bestOffer: number | null = null
      let bestOfferSource: BestOfferResult["bestOfferSource"] = null
      let bestOfferType: BestOfferResult["bestOfferType"] = null
      // ⚠ The age travels WITH the winning leg, and is reset to null whenever a leg
      // that cannot be dated takes over. A stale-looking age left behind by a losing
      // leg would date the wrong number.
      let bestOfferAt: number | null = null
      if (editionOffer != null && editionOffer > 0) {
        bestOffer = editionOffer
        bestOfferSource = "Top Shot Edition"
        bestOfferType = "edition"
        bestOfferAt = editionHit?.at ?? null
      }
      if (serialOffer != null && serialOffer > 0 && (bestOffer == null || serialOffer > bestOffer)) {
        bestOffer = serialOffer
        bestOfferSource = "Top Shot Serial"
        bestOfferType = "serial"
        // `get_serial_offers` returns no timestamp — UNKNOWN, not fresh.
        bestOfferAt = null
      }
      // Non-Top-Shot DapperOffersV2 bid — a per-moment (serial-grain) offer.
      if (momentOffer != null && momentOffer > 0 && (bestOffer == null || momentOffer > bestOffer)) {
        bestOffer = momentOffer
        bestOfferSource = "Dapper Offer"
        bestOfferType = "serial"
        // `marketplace_offers.created_at` is when the OFFER WAS MADE, not when we last
        // confirmed it. Reporting it as an age would assert something we never checked.
        bestOfferAt = null
      }

      return {
        momentId,
        editionKey,
        bestOffer,
        bestOfferSource,
        bestOfferType,
        bestOfferAgeHours:
          bestOffer != null && bestOfferAt != null
            ? (Date.now() - bestOfferAt) / 3_600_000
            : null,
      }
    })

    return NextResponse.json({ results })
  } catch (e) {
    return NextResponse.json(
      {
        // Shape-preserving: the caller reads `results`, so only the message is
        // classified rather than published.
        ...safeApiError(e, "Offers aren't available right now."),
        results: [],
      },
      { status: 500 }
    )
  }
}
