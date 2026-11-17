// ── NFL All Day accepted-offer → sale capture ────────────────────────────────
//
// known-issues #70 (built 2026-10-10). An accepted Dapper OffersV2 offer is a real
// secondary All Day sale that never passes through the storefront path the All Day
// sales indexer watches, so before this lane none reached `sales` (re-measured
// 09-24: ~2.6 % of All Day sales, ~20 a day). The OfferCompleted event carries the
// whole sale: buyer (offerAddress), seller (acceptingAddress), price (offerAmount,
// DUC = USD) and the exact nftId; an EDITION offer also names editionId
// (== All Day editions.external_id).
//
// ⚠ COUNT ROWS THE DB RETURNS, NOT ROWS SENT. `trg_zzz_allday_cross_source_dedup`
// silently folds a same-NFT / same-day / same-price sale from another source into
// the existing row with `RETURN NULL`: the insert succeeds, writes nothing, and a
// bare insert would count it as written. Each row is inserted with `.select("id")`
// and classified written / suppressed / duplicate (23505 on the tx+nft key).

import crypto from "crypto"
import { supabaseAdmin } from "@/lib/supabase"
import { normAddr } from "@/lib/chains/flow/topshot-offer-fill"

export const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const IN_CHUNK = 200

export interface AllDayOfferFill {
  offerId: string
  fillTx: string
  blockTs: string
  blockHeight: number | null
  buyer: string | null
  seller: string | null
  amount: number
  nftId: string | null
  editionExternalId: string | null // EDITION offers only
}

/** An OfferCompleted payload (already CDC-unwrapped) → a fill, or null when it is not a purchase. */
export function parseAllDayOfferFill(
  payload: Record<string, any>,
  fillTx: string,
  blockTs: string,
  blockHeight: number | null,
): AllDayOfferFill | null {
  if (payload?.purchased !== true) return null
  const offerId = payload?.offerId != null ? String(payload.offerId) : null
  if (!offerId || !fillTx) return null
  const amount = payload?.offerAmount != null ? Number(payload.offerAmount) : NaN
  if (!Number.isFinite(amount) || amount <= 0) return null
  const params = (payload?.offerParamsString ?? {}) as Record<string, unknown>
  const isEdition = (params._type ?? params["_type"]) === "EDITION"
  return {
    offerId,
    fillTx,
    blockTs,
    blockHeight,
    buyer: normAddr(payload?.offerAddress),
    seller: normAddr(payload?.acceptingAddress),
    amount,
    nftId: payload?.nftId != null ? String(payload.nftId) : null,
    editionExternalId: isEdition && params.editionId != null ? String(params.editionId) : null,
  }
}

export interface AllDayFillWriteResult {
  written: number
  suppressed: number // the cross-source dedup trigger folded it into an existing row
  duped: number // already in sales (re-scan)
  unresolved: number // no edition could be placed (NOT NULL on sales) — skipped
}

/**
 * Resolve each fill's edition + serial and insert it as a `source='offer_fill'` sale.
 * Every read and every non-duplicate insert error THROWS, so the caller holds its
 * cursor rather than advancing past fills that did not land.
 */
export async function writeAllDayOfferFillSales(fills: AllDayOfferFill[]): Promise<AllDayFillWriteResult> {
  const out: AllDayFillWriteResult = { written: 0, suppressed: 0, duped: 0, unresolved: 0 }
  if (fills.length === 0) return out

  // editions by external_id (EDITION offers)
  const extIds = Array.from(new Set(fills.map((f) => f.editionExternalId).filter((x): x is string => !!x)))
  const editionByExt = new Map<string, string>()
  for (let i = 0; i < extIds.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("external_id", extIds.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`all day editions lookup: ${error.message}`)
    for (const r of (data as Array<{ external_id: string; id: string }> | null) ?? []) editionByExt.set(r.external_id, r.id)
  }

  // the exact nft: moments, then wallet_moments_cache (serial; edition when the offer named none)
  const nftIds = Array.from(new Set(fills.map((f) => f.nftId).filter((x): x is string => !!x)))
  const byNft = new Map<string, { editionId: string | null; editionKey: string | null; serial: number | null }>()
  for (let i = 0; i < nftIds.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("moments")
      .select("nft_id, edition_id, serial_number")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("nft_id", nftIds.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`all day moments lookup: ${error.message}`)
    for (const r of (data as Array<{ nft_id: string; edition_id: string | null; serial_number: number | null }> | null) ?? [])
      byNft.set(r.nft_id, { editionId: r.edition_id, editionKey: null, serial: r.serial_number })
  }
  const notInMoments = nftIds.filter((id) => !byNft.has(id))
  for (let i = 0; i < notInMoments.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, serial_number")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("moment_id", notInMoments.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`all day wallet_moments_cache lookup: ${error.message}`)
    for (const r of (data as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }> | null) ?? [])
      if (!byNft.has(r.moment_id)) byNft.set(r.moment_id, { editionId: null, editionKey: r.edition_key, serial: r.serial_number })
  }
  const extraKeys = Array.from(new Set(Array.from(byNft.values()).map((v) => v.editionKey).filter((k): k is string => !!k && !editionByExt.has(k))))
  for (let i = 0; i < extraKeys.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, id")
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("external_id", extraKeys.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`all day editions lookup (wallet cache keys): ${error.message}`)
    for (const r of (data as Array<{ external_id: string; id: string }> | null) ?? []) editionByExt.set(r.external_id, r.id)
  }

  const nowIso = new Date().toISOString()
  const seenTx = new Set<string>()
  for (const f of fills) {
    if (seenTx.has(f.fillTx)) continue
    seenTx.add(f.fillTx)
    const n = f.nftId ? byNft.get(f.nftId) : undefined
    // The offer's own editionId is authoritative for an EDITION offer; the nft's
    // edition places any other offer type.
    const editionId =
      (f.editionExternalId ? editionByExt.get(f.editionExternalId) : undefined) ??
      n?.editionId ??
      (n?.editionKey ? editionByExt.get(n.editionKey) : undefined) ??
      null
    if (!editionId) { out.unresolved++; continue }
    const row = {
      id: crypto.randomUUID(),
      edition_id: editionId,
      collection_id: ALLDAY_COLLECTION_ID,
      collection: "nfl_all_day",
      nft_id: f.nftId,
      price_usd: f.amount,
      // NULL, never a phantom 0, when the serial is unknown (sales-serial recovery keys on IS NULL).
      serial_number: n?.serial != null && n.serial > 0 ? n.serial : null,
      sold_at: f.blockTs,
      marketplace: "nflallday",
      source: "offer_fill",
      block_height: f.blockHeight,
      transaction_hash: f.fillTx,
      offer_id: f.offerId,
      buyer_address: f.buyer,
      seller_address: f.seller,
      ingested_at: nowIso,
    }
    const { data, error } = await (supabaseAdmin as any).from("sales").insert(row).select("id")
    if (error) {
      if (error.code === "23505") { out.duped++; continue }
      throw new Error(`all day offer_fill sale insert failed: ${error.message}`)
    }
    if (((data as unknown[] | null) ?? []).length > 0) out.written++
    else out.suppressed++
  }
  return out
}
