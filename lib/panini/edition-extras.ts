// lib/panini/edition-extras.ts
//
// Three Panini edition-page sections that Top Shot's edition page has and Panini's did not
// (Panini ↔ Top Shot parity pass, 2026-10-25):
//
//   · OFFERS        — Top Shot: the Activity block's Offers toggle (edition_offers).
//                     Panini: the best offer Panini shows on each serial
//                     (panini_card_serials.best_offer_usd = raw.best_offer on every row,
//                     with raw.offers_count), re-read in the last PANINI_ASK_CONFIRMED_DAYS —
//                     the same confirmation window as the asks on this page.
//   · HOLDERS       — Top Shot: "Top Owners" (named wallets).
//                     Panini: COUNTS ONLY, from mv_panini_holder_concentration — never a
//                     username (decided 2026-10-21 for the Holders board; this keeps it).
//                     Shares are shown only when the MV's census is complete.
//   · PACKS         — Top Shot: "Found in packs" (pack_distributions membership).
//                     Panini publishes no per-pack checklist, so this is the packs of the
//                     edition's PRODUCT — never a claim that a given pack can pull the card.
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   Each read fails on its own to `null` (rendered "couldn't be loaded"), distinct from an
//   ok empty read. No owner handle is returned: the offers read selects `owner` only to
//   say whether a serial is still sealed (blank owner = unopened, measured 10-21).

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import { PANINI_ASK_CONFIRMED_DAYS } from "@/lib/panini/edition-market"

type RawRows = Record<string, unknown>[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const PANINI_OFFERS_LIMIT = 10
const PACKS_LIMIT = 12

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null
}

// ── Offers ──────────────────────────────────────────────────────────────────

export interface PaniniOfferRow {
  serial: number | null
  mintCap: number | null
  bestOfferUsd: number
  offersCount: number | null
  /** The serial's own ask when it is listed (an offer is never above it — measured 10-25). */
  askUsd: number | null
  /** True when the serial has no owner yet — it is still sealed in a pack. */
  sealed: boolean
  seenAt: string | null
}

export interface PaniniEditionOffers {
  /** Highest offers first; null = the read failed. */
  rows: PaniniOfferRow[] | null
  /** Serials carrying a confirmed offer; null = the count failed (rows may still render). */
  serialsWithOffer: number | null
}

export function toOfferRow(r: Record<string, unknown>): PaniniOfferRow | null {
  const offer = num(r.best_offer_usd)
  if (offer === null || offer <= 0) return null
  const owner = typeof r.owner === "string" ? r.owner.trim() : ""
  return {
    serial: num(r.serial_number),
    mintCap: num(r.mint_cap),
    bestOfferUsd: offer,
    offersCount: num(r.offers_count),
    askUsd: r.is_listed === true ? num(r.price_usd) : null,
    sealed: owner === "",
    seenAt: typeof r.captured_at === "string" ? r.captured_at : null,
  }
}

export async function fetchPaniniEditionOffers(externalId: string, db: Db = supabaseAdmin): Promise<PaniniEditionOffers> {
  const since = new Date(Date.now() - PANINI_ASK_CONFIRMED_DAYS * 86_400_000).toISOString()
  const base = () =>
    db.from("panini_card_serials")
  const [rowsRes, countRes] = await Promise.all([
    withQueryDeadline<RawRows>(
      base()
        .select("serial_number,mint_cap,best_offer_usd,offers_count:raw->>offers_count,price_usd,is_listed,owner,captured_at")
        .eq("edition_external_id", externalId)
        .gt("best_offer_usd", 0)
        .gte("captured_at", since)
        .order("best_offer_usd", { ascending: false })
        .order("serial_number", { ascending: true })
        .limit(PANINI_OFFERS_LIMIT),
      "edition/panini-offers",
      apiReadTimeoutMs(),
    ).catch((e: unknown) => ({ data: null, error: e })),
    withQueryDeadline<RawRows>(
      base()
        .select("sku", { count: "exact", head: true })
        .eq("edition_external_id", externalId)
        .gt("best_offer_usd", 0)
        .gte("captured_at", since),
      "edition/panini-offers-count",
      apiReadTimeoutMs(),
    ).catch((e: unknown) => ({ data: null, error: e, count: null })),
  ])
  const rows = rowsRes.error
    ? null
    : ((rowsRes.data ?? []) as Record<string, unknown>[]).map(toOfferRow).filter((x): x is PaniniOfferRow => x !== null)
  const c = (countRes as { count?: unknown }).count
  return { rows, serialsWithOffer: countRes.error || typeof c !== "number" ? null : c }
}

// ── Holders (counts only) ───────────────────────────────────────────────────

export interface PaniniEditionHolders {
  serialsSeen: number | null
  ownedCopies: number | null
  unopenedCopies: number | null
  burntCopies: number | null
  holders: number | null
  top1Copies: number | null
  top3Copies: number | null
  /** 0..1, only meaningful when censusComplete. */
  top1Share: number | null
  top3Share: number | null
  censusComplete: boolean
  computedAt: string | null
}

export function toHolders(r: Record<string, unknown>): PaniniEditionHolders {
  return {
    serialsSeen: num(r.serials_seen),
    ownedCopies: num(r.owned_copies),
    unopenedCopies: num(r.unopened_copies),
    burntCopies: num(r.burnt_copies),
    holders: num(r.holders),
    top1Copies: num(r.top1_copies),
    top3Copies: num(r.top3_copies),
    top1Share: num(r.top1_share),
    top3Share: num(r.top3_share),
    censusComplete: r.census_complete === true,
    computedAt: typeof r.computed_at === "string" ? r.computed_at : null,
  }
}

/** `holders: null` with ok=true means the MV has no row for this edition yet. */
export async function fetchPaniniEditionHolders(
  externalId: string,
  db: Db = supabaseAdmin,
): Promise<{ ok: boolean; holders: PaniniEditionHolders | null }> {
  try {
    const { data, error } = await withQueryDeadline<RawRows>(
      db.from("mv_panini_holder_concentration")
        .select("serials_seen,owned_copies,unopened_copies,burnt_copies,holders,top1_copies,top3_copies,top1_share,top3_share,census_complete,computed_at")
        .eq("external_id", externalId)
        .limit(1),
      "edition/panini-holders",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, holders: null }
    const r = ((data ?? []) as Record<string, unknown>[])[0]
    return { ok: true, holders: r ? toHolders(r) : null }
  } catch {
    return { ok: false, holders: null }
  }
}

// ── Packs from the edition's product ────────────────────────────────────────

export interface PaniniProductPack {
  id: string
  title: string
  productName: string | null
  /** Secondary floor, else the average sale (`costBasis` says which); null = neither known. */
  costUsd: number | null
  costBasis: "floor" | "avg_sale" | null
  packsRemaining: number | null
  packsTotal: number | null
  updatedAt: string | null
  marketUrl: string | null
}

export interface PaniniEditionPacks {
  /** null = the read failed. */
  packs: PaniniProductPack[] | null
  productName: string | null
  /** Copies of THIS edition still sealed (panini_editions.still_in_packs). */
  stillInPacks: number | null
  /** The card is a First-Off-The-Line exclusive (only FOTL packs carry it). */
  fotlExclusive: boolean
  /** The edition's product (panini_products.set_id), for the product-page link; null when unknown or its name read failed. */
  productSetId: number | null
}

export function packTitle(packType: string | null, name: string | null): string {
  const t = (packType ?? "").trim()
  if ((t === "" || t === "pack") && name) return name
  const label = t === "fotl" ? "FOTL" : t ? t.charAt(0).toUpperCase() + t.slice(1) : "Pack"
  return `${label} pack`
}

/** The packs RPC tracks for one Panini product (all its panini_products.set_ids). null = the read failed. */
export async function fetchPaniniProductPacks(
  productSetIds: number[],
  opts: { fotlOnly?: boolean } = {},
  db: Db = supabaseAdmin,
): Promise<{ packs: PaniniProductPack[] | null; productName: string | null }> {
  if (productSetIds.length === 0) return { packs: [], productName: null }
  try {
    const [boardRes, stateRes] = await Promise.all([
      withQueryDeadline<RawRows>(
        db.from("panini_pack_ev_board")
          .select("id,pack_type,floor_usd,avg_sale_usd,packs_total,packs_remaining,updated_at,product_name")
          .in("product_set_id", productSetIds)
          .limit(50),
        "panini/product-packs-board",
        apiReadTimeoutMs(),
      ).catch((err: unknown) => ({ data: null, error: err })),
      withQueryDeadline<RawRows>(
        db.from("panini_pack_state").select("id,pack_name:raw->>pack_name,page_url").in("product_set_id", productSetIds).limit(50),
        "panini/product-packs-state",
        apiReadTimeoutMs(),
      ).catch((err: unknown) => ({ data: null, error: err })),
    ])
    if (boardRes.error) return { packs: null, productName: null }
    // The state read only adds names and links; its failure leaves them off, never the packs.
    const meta = new Map<string, { name: string | null; url: string | null }>()
    if (!stateRes.error) {
      for (const s of (stateRes.data ?? []) as Record<string, unknown>[]) {
        const url = str(s.page_url)
        meta.set(String(s.id), { name: str(s.pack_name), url: url && /^https:\/\/[a-z0-9.-]*paniniamerica\.net\//i.test(url) ? url : null })
      }
    }
    let productName: string | null = null
    let packs: PaniniProductPack[] = ((boardRes.data ?? []) as Record<string, unknown>[]).map((r) => {
      const id = String(r.id)
      const m = meta.get(id)
      const floor = num(r.floor_usd)
      const avg = num(r.avg_sale_usd)
      productName ??= str(r.product_name)
      return {
        id,
        title: packTitle(str(r.pack_type), m?.name ?? null),
        productName: str(r.product_name),
        costUsd: floor ?? avg,
        costBasis: floor !== null ? "floor" : avg !== null ? "avg_sale" : null,
        packsRemaining: num(r.packs_remaining),
        packsTotal: num(r.packs_total),
        updatedAt: typeof r.updated_at === "string" ? r.updated_at : null,
        marketUrl: m?.url ?? null,
      }
    })
    // A FOTL exclusive comes only from FOTL packs — showing the Hobby box would mislead.
    if (opts.fotlOnly) packs = packs.filter((p) => /fotl/i.test(p.title))
    packs.sort((a, b) => (b.packsRemaining ?? -1) - (a.packsRemaining ?? -1) || a.title.localeCompare(b.title))
    return { packs: packs.slice(0, PACKS_LIMIT), productName }
  } catch {
    return { packs: null, productName: null }
  }
}

export async function fetchPaniniEditionPacks(externalId: string, db: Db = supabaseAdmin): Promise<PaniniEditionPacks> {
  const failed: PaniniEditionPacks = { packs: null, productName: null, stillInPacks: null, fotlExclusive: false, productSetId: null }
  try {
    const ed = await withQueryDeadline<RawRows>(
      db.from("panini_editions").select("product_set_id,still_in_packs,is_fotl_exclusive").eq("external_id", externalId).limit(1),
      "edition/panini-packs-edition",
      apiReadTimeoutMs(),
    )
    if (ed.error) return failed
    const e = ((ed.data ?? []) as Record<string, unknown>[])[0]
    const stillInPacks = e ? num(e.still_in_packs) : null
    const fotlExclusive = e?.is_fotl_exclusive === true
    const productSetId = e ? num(e.product_set_id) : null
    if (productSetId === null) return { packs: [], productName: null, stillInPacks, fotlExclusive, productSetId: null }
    // The product's NAME decides its page (one page per name — 20261026013714); the packs are this card's
    // own set id's (another drop under the same name sells other cards). A failed name read only drops the link.
    const [r, nameRes] = await Promise.all([
      fetchPaniniProductPacks([productSetId], { fotlOnly: fotlExclusive }, db),
      withQueryDeadline<RawRows>(
        db.from("panini_products").select("name").eq("set_id", productSetId).limit(1),
        "edition/panini-product-name",
        apiReadTimeoutMs(),
      ).catch((err: unknown) => ({ data: null, error: err })),
    ])
    const productName = nameRes.error ? null : str(((nameRes.data ?? []) as Record<string, unknown>[])[0]?.name)
    return { packs: r.packs, productName: productName ?? r.productName, stillInPacks, fotlExclusive, productSetId: nameRes.error ? null : productSetId }
  } catch {
    return failed
  }
}
