// ── Top Shot OffersV2 OfferAvailable parsing ─────────────────────────────────
//
// Shared by the live offers indexer (app/api/topshot-offers-indexer) and the
// historical offers backfill (app/api/admin/backfill-topshot-offers). Both read
// Dapper's generic OffersV2 contract (0xb8ea91944fd51c43) filtered to TopShot.NFT.
//
// Offer param shapes (verified on-chain via Cadence MCP + live event decode):
//   _type=TopShotEdition     -> setId, playId               => external_id "setId:playId"   (offer_type 'edition')
//   _type=TopShotSubedition  -> setId, playId, subeditionId => "setId:playId::subeditionId"  (offer_type 'subedition')
//   _type=NFT                -> nftId                        => moments.nft_id -> edition_id+serial (offer_type 'serial')

import { supabaseAdmin } from "@/lib/supabase"
import { fetchTopShotEditionAliases, canonicalTopShotExternalId } from "@/lib/topshot/edition-aliases"

export type AvailOffer = {
  offerId: string
  txHash: string
  blockTs: string
  amount: number
  offerer: string | null
  offerType: "edition" | "subedition" | "serial"
  externalId: string | null // setId:playId (edition/subedition)
  nftId: string | null // serial
}

// Minimal JSON-CDC unwrapper (mirror of the AllDay sales/offers indexers).
export function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        return value
    }
  }
  return node
}

export function parseOfferAvailable(payload: Record<string, any>): Omit<AvailOffer, "txHash" | "blockTs"> | null {
  const offerId = payload?.offerId != null ? String(payload.offerId) : null
  if (!offerId) return null
  const amount = payload?.offerAmount != null ? Number(payload.offerAmount) : NaN
  if (!Number.isFinite(amount) || amount <= 0) return null
  const offerer = payload?.offerAddress != null ? String(payload.offerAddress) : null
  const ps = (payload?.offerParamsString ?? {}) as Record<string, unknown>
  const t = String(ps._type ?? ps["_type"] ?? "")
  if (t === "TopShotEdition") {
    if (ps.setId == null || ps.playId == null) return null
    return { offerId, amount, offerer, offerType: "edition", externalId: `${ps.setId}:${ps.playId}`, nftId: null }
  }
  if (t === "TopShotSubedition") {
    if (ps.setId == null || ps.playId == null) return null
    // Since Stage B (2026-06-20) each named parallel is its OWN editions row
    // keyed "setId:playId::subeditionId" — key the offer there so parallel
    // pages surface their own subedition offers. Resolution falls back to the
    // base pair when no :: edition is cataloged (yet). Pre-2026-07-07 rows
    // dropped the subeditionId and rolled up to base (re-keyed by the
    // audit_20260707 backfill where recoverable).
    const subId = ps.subeditionId != null ? String(ps.subeditionId) : null
    const externalId = subId && /^\d+$/.test(subId) && subId !== "0"
      ? `${ps.setId}:${ps.playId}::${subId}`
      : `${ps.setId}:${ps.playId}`
    return { offerId, amount, offerer, offerType: "subedition", externalId, nftId: null }
  }
  if (t === "NFT") {
    if (ps.nftId == null) return null
    return { offerId, amount, offerer, offerType: "serial", externalId: null, nftId: String(ps.nftId) }
  }
  return null // unknown TS offer type
}

// ── Resolve offers to editions/moments ───────────────────────────────────────
//
// Mirrors step 2 of the live indexer (alias → editions → moments). Every read
// THROWS on error: a swallowed read makes every offer look "uncataloged", and a
// caller that then advances a cursor loses those offers for good.


const TS_COLLECTION = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const IN_CHUNK = 200

export interface ResolvedOfferTarget {
  editionId: string
  momentId: string | null
  serial: number | null
}

export async function resolveOfferTargets(
  avail: AvailOffer[],
): Promise<{ byOfferId: Map<string, ResolvedOfferTarget>; aliased: number }> {
  let aliased = 0
  const aliases = await fetchTopShotEditionAliases()
  for (const o of avail) {
    if (!o.externalId) continue
    const canonical = canonicalTopShotExternalId(o.externalId, aliases)
    if (canonical !== o.externalId) { o.externalId = canonical; aliased++ }
  }
  const extKeys = Array.from(new Set(avail.filter((o) => o.externalId).flatMap((o) => {
    const k = o.externalId!
    return k.includes("::") ? [k, k.split("::")[0]] : [k]
  })))
  const nftIds = Array.from(new Set(avail.filter((o) => o.nftId).map((o) => o.nftId!)))

  const editionIdByExt = new Map<string, string>()
  for (let i = 0; i < extKeys.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, id")
      .eq("collection_id", TS_COLLECTION)
      .in("external_id", extKeys.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`editions lookup: ${error.message}`)
    for (const r of (data as Array<{ external_id: string; id: string }> | null) ?? []) editionIdByExt.set(r.external_id, r.id)
  }

  const momentByNft = new Map<string, ResolvedOfferTarget>()
  for (let i = 0; i < nftIds.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("moments")
      .select("nft_id, id, edition_id, serial_number")
      .eq("collection_id", TS_COLLECTION)
      .in("nft_id", nftIds.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`moments lookup: ${error.message}`)
    for (const r of (data as Array<{ nft_id: string; id: string; edition_id: string; serial_number: number | null }> | null) ?? [])
      momentByNft.set(r.nft_id, { editionId: r.edition_id, momentId: r.id, serial: r.serial_number })
  }

  const byOfferId = new Map<string, ResolvedOfferTarget>()
  for (const o of avail) {
    if (o.externalId) {
      const editionId = editionIdByExt.get(o.externalId)
        ?? (o.externalId.includes("::") ? editionIdByExt.get(o.externalId.split("::")[0]) : undefined)
      if (editionId) byOfferId.set(o.offerId, { editionId, momentId: null, serial: null })
    } else if (o.nftId) {
      const m = momentByNft.get(o.nftId)
      if (m) byOfferId.set(o.offerId, m)
    }
  }
  return { byOfferId, aliased }
}
