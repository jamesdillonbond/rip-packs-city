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
): Promise<{ byOfferId: Map<string, ResolvedOfferTarget>; aliased: number; viaWalletCache: number; viaCheckpoint: number }> {
  let aliased = 0
  let viaWalletCache = 0
  let viaCheckpoint = 0
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

  // Serial-offer fallback (2026-10-10). `moments` is sparse, and a serial offer on
  // an nft it lacks was DROPPED — ~18 % of all offers the live indexer saw in a
  // day. wallet_moments_cache knows far more nfts: moment_id IS the nft id for
  // Top Shot, edition_key IS editions.external_id (both verified live). Several
  // wallets can hold a row for one nft (stale holders); they agree on edition and
  // serial, so the first row with an edition_key wins.
  const missingNfts = nftIds.filter((id) => !momentByNft.has(id))
  const wmcByNft = new Map<string, { editionKey: string; serial: number | null }>()
  for (let i = 0; i < missingNfts.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, serial_number")
      .eq("collection_id", TS_COLLECTION)
      .in("moment_id", missingNfts.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`wallet_moments_cache lookup: ${error.message}`)
    for (const r of (data as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }> | null) ?? []) {
      if (r.edition_key && !wmcByNft.has(r.moment_id)) {
        wmcByNft.set(r.moment_id, { editionKey: canonicalTopShotExternalId(r.edition_key, aliases), serial: r.serial_number })
      }
    }
  }
  // Second fallback: the chain checkpoint map (`checkpoint_nft_meta`, decoded from
  // spork-root state; c='ts' → a=setID, b=playID, serial; c='tssub' → a=subedition;
  // verified live 2026-10-10). Latest spork wins. ⛔ A parallel must never fold onto
  // its base: the key is built only when the SUBEDITION is known — a 'tssub' row or a
  // topshot_moment_subeditions row — and a parallel whose "::" edition is not
  // cataloged stays unresolved (no base fallback here).
  const stillMissing = missingNfts.filter((id) => !wmcByNft.has(id) && /^\d+$/.test(id))
  const ckptByNft = new Map<string, { editionKey: string; serial: number | null }>()
  if (stillMissing.length > 0) {
    const ts = new Map<string, { set: number; play: number; serial: number | null; spork: number }>()
    const sub = new Map<string, { sub: number; spork: number }>()
    for (let i = 0; i < stillMissing.length; i += IN_CHUNK) {
      const { data, error } = await (supabaseAdmin as any)
        .from("checkpoint_nft_meta")
        .select("c, nft_id, a, b, serial, spork")
        .in("c", ["ts", "tssub"])
        .in("nft_id", stillMissing.slice(i, i + IN_CHUNK).map(Number))
      if (error) throw new Error(`checkpoint_nft_meta lookup: ${error.message}`)
      for (const r of (data as Array<{ c: string; nft_id: number | string; a: number | null; b: number | null; serial: number | null; spork: number }> | null) ?? []) {
        const id = String(r.nft_id)
        if (r.c === "ts" && r.a != null && r.b != null) {
          const prev = ts.get(id)
          if (!prev || r.spork > prev.spork) ts.set(id, { set: Number(r.a), play: Number(r.b), serial: r.serial != null ? Number(r.serial) : null, spork: r.spork })
        } else if (r.c === "tssub" && r.a != null) {
          const prev = sub.get(id)
          if (!prev || r.spork > prev.spork) sub.set(id, { sub: Number(r.a), spork: r.spork })
        }
      }
    }
    const needSub = Array.from(ts.keys()).filter((id) => !sub.has(id))
    for (let i = 0; i < needSub.length; i += IN_CHUNK) {
      const { data, error } = await (supabaseAdmin as any)
        .from("topshot_moment_subeditions")
        .select("nft_id, subedition_id")
        .in("nft_id", needSub.slice(i, i + IN_CHUNK))
        .not("subedition_id", "is", null)
      if (error) throw new Error(`topshot_moment_subeditions lookup: ${error.message}`)
      for (const r of (data as Array<{ nft_id: string | number; subedition_id: number }> | null) ?? [])
        sub.set(String(r.nft_id), { sub: Number(r.subedition_id), spork: -1 })
    }
    for (const [id, t] of ts) {
      const sd = sub.get(id)
      if (!sd) continue // subedition unknown → never guess Standard
      const base = canonicalTopShotExternalId(`${t.set}:${t.play}`, aliases)
      ckptByNft.set(id, { editionKey: sd.sub > 0 ? `${base}::${sd.sub}` : base, serial: t.serial })
    }
  }

  const wmcKeys = Array.from(new Set([
    ...Array.from(wmcByNft.values()).map((w) => w.editionKey),
    ...Array.from(ckptByNft.values()).map((w) => w.editionKey),
  ])).filter((k) => !editionIdByExt.has(k))
  for (let i = 0; i < wmcKeys.length; i += IN_CHUNK) {
    const { data, error } = await (supabaseAdmin as any)
      .from("editions")
      .select("external_id, id")
      .eq("collection_id", TS_COLLECTION)
      .in("external_id", wmcKeys.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`editions lookup (wallet cache keys): ${error.message}`)
    for (const r of (data as Array<{ external_id: string; id: string }> | null) ?? []) editionIdByExt.set(r.external_id, r.id)
  }

  const byOfferId = new Map<string, ResolvedOfferTarget>()
  for (const o of avail) {
    if (o.externalId) {
      const editionId = editionIdByExt.get(o.externalId)
        ?? (o.externalId.includes("::") ? editionIdByExt.get(o.externalId.split("::")[0]) : undefined)
      if (editionId) byOfferId.set(o.offerId, { editionId, momentId: null, serial: null })
    } else if (o.nftId) {
      const m = momentByNft.get(o.nftId)
      if (m) { byOfferId.set(o.offerId, m); continue }
      const w = wmcByNft.get(o.nftId)
      const editionId = w ? editionIdByExt.get(w.editionKey) : undefined
      if (w && editionId) {
        byOfferId.set(o.offerId, { editionId, momentId: null, serial: w.serial })
        viaWalletCache++
        continue
      }
      const k = ckptByNft.get(o.nftId)
      const kEditionId = k ? editionIdByExt.get(k.editionKey) : undefined
      if (k && kEditionId) {
        byOfferId.set(o.offerId, { editionId: kEditionId, momentId: null, serial: k.serial })
        viaCheckpoint++
      }
    }
  }
  return { byOfferId, aliased, viaWalletCache, viaCheckpoint }
}
