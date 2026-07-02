// ── Top Shot accepted-offer → sale capture ───────────────────────────────────
//
// Accepted Dapper OffersV2 offers (contract 0xb8ea91944fd51c43) are real
// secondary Top Shot sales that NEVER flow through the NFTStorefront /
// TopShotMarketV3 listing path the sales-indexer watches — so until this lane
// they were entirely uncaptured (~340 TS sales/day).
//
// The OfferCompleted event is rich enough to build the whole sale with NO tx
// decode (verified against the on-chain OffersV2 source 2026-06-20):
//
//   OfferCompleted(
//     purchased: Bool,              // true = accepted (a sale); false = cancelled/burned
//     acceptingAddress: Address?,   // the SELLER (accepted the offer / received payment)
//     offerAddress: Address,        // the BUYER (the offerer)
//     offerId: UInt64,
//     nftType: Type,
//     offerAmount: UFix64,          // the SALE PRICE (DUC = USD, gross before royalties)
//     offerType: String,
//     offerParamsString: {String:String},  // setId/playId for edition/subedition
//     nftId: UInt64?,               // the EXACT moment that satisfied the offer
//     ...
//   )
//
// So buyer, seller, price, and the specific nftId are all on the event — even
// for edition/subedition offers. No /v1/transactions Step-5b decode needed.
//
// Sale rows are written with source='offer_fill' and transaction_hash = the
// OfferCompleted (fill) tx, which is distinct from offers.tx_hash (the creation
// tx) — that's why a filled offer never matched a sale before. Idempotency rides
// on the sales transaction_hash unique index; re-runs ignore dupes.

import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

export const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DB_IN_CHUNK = 200

// ── JSON-CDC type helpers (mirror the offers indexer) ────────────────────────

export function extractNftTypeId(field: unknown): string | undefined {
  if (typeof field === "string") return field
  if (field && typeof field === "object") {
    const st = (field as Record<string, unknown>).staticType
    if (typeof st === "string") return st
    if (st && typeof st === "object") {
      const id = (st as Record<string, unknown>).typeID
      if (typeof id === "string") return id
    }
  }
  return undefined
}

export function isTopShotNftType(nftType: unknown): boolean {
  return extractNftTypeId(nftType)?.endsWith(".TopShot.NFT") ?? false
}

export function normAddr(a: unknown): string | null {
  if (a == null) return null
  const s = String(a).trim().toLowerCase().replace(/^0x/, "")
  if (s.length === 0) return null
  return "0x" + s
}

function toIsoTimestamp(ts: string | number | Date): string {
  if (typeof ts === "string") {
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  if (typeof ts === "number") {
    const d = new Date(ts > 1e12 ? ts : ts * 1000)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

// ── Fill event ───────────────────────────────────────────────────────────────

export interface OfferFillEvent {
  offerId: string
  fillTx: string
  blockTs: string
  blockHeight: number | null
  buyer: string | null // offerAddress (offerer)
  seller: string | null // acceptingAddress
  amount: number // offerAmount (DUC = USD)
  nftId: string | null // the moment that satisfied the offer
  offerType: "edition" | "subedition" | "serial" | "unknown"
  externalId: string | null // setId:playId (edition/subedition only)
}

// Parse an UNWRAPPED OfferCompleted payload into a fill event.
// Returns null for cancelled (purchased!=true), non-TopShot, or malformed.
export function parseOfferCompletedFill(
  payload: Record<string, any>,
  fillTx: string,
  blockTs: string,
  blockHeight: number | null,
): OfferFillEvent | null {
  if (payload?.purchased !== true) return null
  if (!isTopShotNftType(payload?.nftType)) return null
  const offerId = payload?.offerId != null ? String(payload.offerId) : null
  if (!offerId) return null
  if (!fillTx) return null
  const amount = payload?.offerAmount != null ? Number(payload.offerAmount) : NaN
  // amount==NaN/<=0 is tolerated here (offers-row fallback supplies price); keep the row.
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : NaN
  const nftId = payload?.nftId != null ? String(payload.nftId) : null
  const ps = (payload?.offerParamsString ?? {}) as Record<string, unknown>
  const t = String(ps._type ?? ps["_type"] ?? "")
  let offerType: OfferFillEvent["offerType"] = "unknown"
  let externalId: string | null = null
  if (t === "TopShotEdition") {
    offerType = "edition"
    if (ps.setId != null && ps.playId != null) externalId = `${ps.setId}:${ps.playId}`
  } else if (t === "TopShotSubedition") {
    offerType = "subedition"
    if (ps.setId != null && ps.playId != null) externalId = `${ps.setId}:${ps.playId}`
  } else if (t === "NFT") {
    offerType = "serial"
  }
  return {
    offerId,
    fillTx,
    blockTs,
    blockHeight,
    buyer: normAddr(payload?.offerAddress),
    seller: normAddr(payload?.acceptingAddress),
    amount: safeAmount,
    nftId,
    offerType,
    externalId,
  }
}

// ── Resolve edition/serial and build sale rows ───────────────────────────────

// A ::subID parallel external_id (e.g. "257:8664::18") → its base setID:playID.
// Mirrors the sales-indexer Step-4e F1 guard so this writer can't land a
// mis-keyed Standard moment (a base serial on a /50 ::sub edition) onto a
// parallel edition. (docs/handoff-2026-07-02 P7.)
const PARALLEL_EXT_RE = /^([0-9]+:[0-9]+)::[0-9]+$/
function baseExtIdOf(ext: string): string | null {
  const m = PARALLEL_EXT_RE.exec(ext)
  return m ? m[1] : null
}

export interface BuiltOfferFillSales {
  rows: any[]
  unresolved: number // could not resolve an edition_id (NOT NULL on sales)
  serialsResolved: number
  parallelRedirects: number // F1 guard: impossible-serial parallel → base redirects
}

// Build sale rows from fills, resolving edition_id + serial via:
//   1. moments by nft_id   (best — gives the exact edition + true serial)
//   2. editions by setId:playId (edition/subedition fallback; serial unknown)
//   3. the offers row by offer_id (final fallback — every offer has edition_id)
// Dupes within `fills` sharing a fill tx are collapsed (sales tx-hash is unique).
//
// F1 GUARD (P7): resolution path 1 trusts moments.edition_id blindly, but ~1,200
// moments are F1-mis-attributed — their edition_id points at a ::subID parallel
// while their serial_number is a base serial (impossible for the parallel, e.g.
// serial 910 on a /50 ::18). Before pushing a row, if the resolved edition is a
// parallel and the serial exceeds that parallel's circulation_count, the sale is
// redirected to the base setID:playID edition — mirroring the sales-indexer
// Step-4e guard. Genuine subedition fills (serial <= parallel circ) pass through.
export async function buildOfferFillSales(fills: OfferFillEvent[]): Promise<BuiltOfferFillSales> {
  const byTx = new Map<string, OfferFillEvent>()
  for (const f of fills) if (f.fillTx && !byTx.has(f.fillTx)) byTx.set(f.fillTx, f)
  const list = Array.from(byTx.values())
  if (list.length === 0) return { rows: [], unresolved: 0, serialsResolved: 0, parallelRedirects: 0 }

  const extKeys = Array.from(new Set(list.filter((f) => f.externalId).map((f) => f.externalId!)))
  const nftIds = Array.from(new Set(list.filter((f) => f.nftId).map((f) => f.nftId!)))
  const offerIds = Array.from(new Set(list.map((f) => f.offerId)))

  // 1. editions by external_id (setId:playId)
  const edByExt = new Map<string, string>()
  for (let i = 0; i < extKeys.length; i += DB_IN_CHUNK) {
    const chunk = extKeys.slice(i, i + DB_IN_CHUNK)
    const { data } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, id")
      .eq("collection_id", TS_COLLECTION_ID)
      .in("external_id", chunk)
    for (const r of (data as Array<{ external_id: string; id: string }> | null) ?? []) edByExt.set(r.external_id, r.id)
  }

  // 2. moments by nft_id -> edition_id + serial
  const momByNft = new Map<string, { editionId: string; serial: number | null }>()
  for (let i = 0; i < nftIds.length; i += DB_IN_CHUNK) {
    const chunk = nftIds.slice(i, i + DB_IN_CHUNK)
    const { data } = await (supabaseAdmin as any)
      .from("moments")
      .select("nft_id, edition_id, serial_number")
      .in("nft_id", chunk)
    for (const r of (data as Array<{ nft_id: string; edition_id: string; serial_number: number | null }> | null) ?? []) {
      if (r.edition_id) momByNft.set(r.nft_id, { editionId: r.edition_id, serial: r.serial_number ?? null })
    }
  }

  // 3. offers fallback by offer_id
  const offRow = new Map<string, { editionId: string | null; serial: number | null; buyer: string | null; amount: number | null }>()
  for (let i = 0; i < offerIds.length; i += DB_IN_CHUNK) {
    const chunk = offerIds.slice(i, i + DB_IN_CHUNK)
    const { data } = await (supabaseAdmin as any)
      .from("offers")
      .select("offer_id, edition_id, serial_number, buyer_address, offer_amount_usd")
      .eq("collection_id", TS_COLLECTION_ID)
      .in("offer_id", chunk)
    for (const r of (data as Array<{ offer_id: string; edition_id: string | null; serial_number: number | null; buyer_address: string | null; offer_amount_usd: number | null }> | null) ?? [])
      offRow.set(r.offer_id, { editionId: r.edition_id, serial: r.serial_number, buyer: r.buyer_address ? normAddr(r.buyer_address) : null, amount: r.offer_amount_usd != null ? Number(r.offer_amount_usd) : null })
  }

  // F1 guard maps: reverse-resolve every edition that could be assigned →
  // external_id + circulation_count, and for the ::subID ones the base edition id.
  // A no-op on any tick with no parallel-keyed resolutions.
  const assignableEdIds = new Set<string>()
  for (const id of edByExt.values()) assignableEdIds.add(id)
  for (const v of momByNft.values()) assignableEdIds.add(v.editionId)
  for (const v of offRow.values()) if (v.editionId) assignableEdIds.add(v.editionId)

  const edIdToMeta = new Map<string, { ext: string; circ: number | null }>()
  const assignableArr = Array.from(assignableEdIds)
  for (let i = 0; i < assignableArr.length; i += DB_IN_CHUNK) {
    const chunk = assignableArr.slice(i, i + DB_IN_CHUNK)
    const { data } = await (supabaseAdmin as any)
      .from("editions")
      .select("id, external_id, circulation_count")
      .in("id", chunk)
    for (const r of (data as Array<{ id: string; external_id: string; circulation_count: number | null }> | null) ?? [])
      edIdToMeta.set(r.id, { ext: r.external_id, circ: r.circulation_count ?? null })
  }

  const baseKeyToId = new Map<string, string>()
  const baseKeysNeeded = new Set<string>()
  for (const m of edIdToMeta.values()) {
    const base = baseExtIdOf(m.ext)
    if (base) baseKeysNeeded.add(base)
  }
  const baseArr = Array.from(baseKeysNeeded)
  for (let i = 0; i < baseArr.length; i += DB_IN_CHUNK) {
    const chunk = baseArr.slice(i, i + DB_IN_CHUNK)
    const { data } = await (supabaseAdmin as any)
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", TS_COLLECTION_ID)
      .in("external_id", chunk)
    for (const r of (data as Array<{ id: string; external_id: string }> | null) ?? [])
      baseKeyToId.set(r.external_id, r.id)
  }

  const rows: any[] = []
  let unresolved = 0
  let serialsResolved = 0
  let parallelRedirects = 0
  const nowIso = new Date().toISOString()

  for (const f of list) {
    let editionId: string | null = null
    let serial: number | null = null

    if (f.nftId) {
      const m = momByNft.get(f.nftId)
      if (m) {
        editionId = m.editionId
        serial = m.serial
      }
    }
    if (!editionId && f.externalId) editionId = edByExt.get(f.externalId) ?? null
    const fb = offRow.get(f.offerId)
    if (!editionId && fb?.editionId) editionId = fb.editionId
    if (serial == null && fb?.serial != null) serial = fb.serial

    if (!editionId) {
      unresolved++
      continue
    }

    // F1 guard: a Standard nft must never land on a ::subID parallel. If the
    // resolved edition is a parallel and the serial exceeds that parallel's
    // circulation (impossible), redirect the sale to the base setID:playID
    // edition. Genuine subedition fills (serial <= parallel circ) pass through.
    const meta = edIdToMeta.get(editionId)
    if (meta && serial != null && meta.circ != null && serial > meta.circ) {
      const base = baseExtIdOf(meta.ext)
      const baseId = base ? baseKeyToId.get(base) : null
      if (baseId && baseId !== editionId) {
        editionId = baseId
        parallelRedirects++
      }
    }

    const buyer = f.buyer ?? fb?.buyer ?? null
    const price = Number.isFinite(f.amount) && f.amount > 0 ? f.amount : (fb?.amount ?? 0)
    if (serial != null && serial > 0) serialsResolved++

    rows.push({
      id: crypto.randomUUID(),
      edition_id: editionId,
      collection_id: TS_COLLECTION_ID,
      collection: "nba_top_shot",
      nft_id: f.nftId,
      price_usd: price,
      serial_number: serial ?? 0,
      sold_at: toIsoTimestamp(f.blockTs),
      marketplace: "topshot",
      source: "offer_fill",
      block_height: f.blockHeight,
      transaction_hash: f.fillTx,
      buyer_address: buyer,
      seller_address: f.seller,
      payer_address: null,
      proposer_address: null,
      ingested_at: nowIso,
    })
  }

  return { rows, unresolved, serialsResolved, parallelRedirects }
}

// Stamp the OfferCompleted (fill) tx onto the matching offer rows for provenance.
// Mirrors the forward indexer's step 4c, but is the lane the historical backfill
// uses — the forward path only stamps completions seen in its go-forward window,
// so the ~6,869 offers filled before that lane existed are only reachable here.
// Best-effort + idempotent: stamps only where fill_tx_hash IS NULL; the sale's
// idempotency does NOT depend on it. Returns the number of offer rows stamped.
export async function stampOfferFillTxHashes(fills: OfferFillEvent[]): Promise<{ stamped: number }> {
  // one fill tx per offer_id (first wins — an offer fills exactly once)
  const fillTxByOfferId = new Map<string, string>()
  for (const f of fills) {
    if (f.offerId && f.fillTx && !fillTxByOfferId.has(f.offerId)) fillTxByOfferId.set(f.offerId, f.fillTx)
  }
  let stamped = 0
  for (const [offerId, txHash] of fillTxByOfferId) {
    const { error, count } = await (supabaseAdmin as any)
      .from("offers")
      .update({ fill_tx_hash: txHash }, { count: "exact" })
      .eq("collection_id", TS_COLLECTION_ID)
      .eq("offer_id", offerId)
      .is("fill_tx_hash", null)
    if (error) {
      console.log("[offer-fill] fill_tx_hash stamp error:", error.message)
      continue
    }
    stamped += count ?? 0
  }
  return { stamped }
}

// Insert sale rows in batches, ignoring transaction_hash dupes (idempotent).
export async function insertOfferFillSales(rows: any[]): Promise<{ inserted: number; duped: number }> {
  let inserted = 0
  let duped = 0
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100)
    try {
      const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
      if (error) {
        if (error.code === "23505") {
          // batch hit a dupe — retry individually so the non-dupes still land
          for (const row of batch) {
            const { error: e1 } = await (supabaseAdmin as any).from("sales").insert(row)
            if (e1) duped++
            else inserted++
          }
        } else {
          console.log("[offer-fill] sales insert error:", error.message)
          duped += batch.length
        }
      } else {
        inserted += batch.length
      }
    } catch (err) {
      console.log("[offer-fill] sales insert threw:", err instanceof Error ? err.message : String(err))
      for (const row of batch) {
        try {
          const { error: e1 } = await (supabaseAdmin as any).from("sales").insert(row)
          if (e1) duped++
          else inserted++
        } catch {
          duped++
        }
      }
    }
  }
  return { inserted, duped }
}
