// lib/packs-sold-outcomes.ts
//
// 2026-11-27 (Trevor: "I'd like to see if any of the packs I sold had something good").
// Shared by /api/wallet/sold-pack-outcomes and the binder's Sold tab (WalletPacksView).
// The payload comes from get_wallet_sold_pack_outcomes (migration audit_20261127_sold_pack_outcomes).

export interface SoldPackPull {
  nft_id: string
  edition_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  circulation_count: number | null
  fmv_usd: number | null
  /** Top Shot parallel (editions.subedition_name), e.g. "Hexwave"; null on the Standard printing. */
  parallel?: string | null
}

export interface SoldPackOutcome {
  pack_nft_id: string
  sold_at: string | null
  sale_price: number | null
  opened: boolean
  opened_at: string | null
  /** The seller bought it back and opened it themselves. */
  opener_is_you: boolean
  /** Username only -- an opener with no known username is never named by address. */
  opener_username: string | null
  /** A box or case: it opened into packs, and `pulls` are the moments of those packs (v2, 11-27). */
  is_container?: boolean
  /** For a box or case: packs inside (a case counts the packs inside its boxes) and how many are opened. */
  packs_inside?: number | null
  packs_opened?: number | null
  /** Dapper's index says it was opened, but nothing it yielded is on record. */
  contents_unknown?: boolean
  /** A sold box/case with no open on record whose index row does not say Sealed: opened or not is unknown. */
  open_status_unknown?: boolean
  moments_pulled: number | null
  pulls_named: number
  pulls_priced: number
  /** Current FMV of every pull; NULL unless every pull is named AND priced (never a partial sum). */
  pull_value_usd: number | null
  /** Best first (by current FMV). */
  pulls: SoldPackPull[]
}

export const SOLD_PACK_OUTCOMES_MAX_IDS = 100
const PACK_ID_RE = /^[0-9]{1,24}$/

/** null = invalid (too many, or a non-numeric id); [] = nothing asked. */
export function parseSoldPackIds(raw: string | null): string[] | null {
  if (!raw) return []
  const ids = Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)))
  if (ids.length > SOLD_PACK_OUTCOMES_MAX_IDS) return null
  if (!ids.every((id) => PACK_ID_RE.test(id))) return null
  return ids
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s_-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
}

/** "LeBron James · Legendary #14/39" -- or "Unnamed Moment" when no edition is known. */
export function soldPullLabel(p: SoldPackPull): string {
  const name = p.player_name?.trim() || "Unnamed Moment"
  const tier = p.tier ? titleCase(p.tier) : null
  const serial = p.serial_number != null
    ? `#${p.serial_number}${p.circulation_count ? "/" + p.circulation_count : ""}`
    : null
  // The non-parallel printing is "Standard", never "Base" (Base is a set name) -- it gets no tag.
  const par = p.parallel?.trim()
  const parallel = par && !/^(standard|base)$/i.test(par) ? par : null
  const tail = [tier, parallel, serial].filter(Boolean).join(" ")
  return tail ? `${name} · ${tail}` : name
}

/** Who opened it: "You", "@username", or "Another collector" (never an address). */
export function soldOpenerLabel(o: SoldPackOutcome): string {
  if (o.opener_is_you) return "You"
  if (o.opener_username) return "@" + o.opener_username
  return "Another collector"
}

/**
 * The cell's headline. Three states, never two: not opened yet · opened and fully valued ·
 * opened but the total is unknown (some pulls unnamed or unpriced -- said, not summed).
 */
export function soldOutcomeValueLabel(o: SoldPackOutcome): string {
  if (o.open_status_unknown) return "Open status unknown"
  if (!o.opened) return "Not opened yet"
  if (o.contents_unknown) return "Opened · contents not on record"
  if (o.pull_value_usd != null) return usd(o.pull_value_usd)
  if (o.is_container && o.packs_inside != null && o.packs_opened != null && o.packs_opened < o.packs_inside) {
    return `${o.packs_opened} of ${o.packs_inside} packs opened`
  }
  const total = o.moments_pulled ?? o.pulls.length
  return `${o.pulls_priced} of ${total} priced`
}

/** "Box · 8 packs" -- what a container opened into; null for an ordinary pack. */
export function soldContainerLabel(o: SoldPackOutcome): string | null {
  if (!o.is_container || o.packs_inside == null) return null
  return `${o.packs_inside} pack${o.packs_inside === 1 ? "" : "s"} inside`
}

/** Pull value against what the pack sold for: positive = the buyer came out ahead. */
export function soldOutcomeVsSale(o: SoldPackOutcome): number | null {
  if (o.pull_value_usd == null || o.sale_price == null) return null
  return Math.round((o.pull_value_usd - o.sale_price) * 100) / 100
}

/** A "hit" = the pulls are worth more than the pack sold for. */
export function soldOutcomeIsHit(o: SoldPackOutcome): boolean {
  const d = soldOutcomeVsSale(o)
  return d != null && d > 0
}

export function soldOutcomeVsSaleLabel(o: SoldPackOutcome): string | null {
  const d = soldOutcomeVsSale(o)
  if (d == null) return null
  if (d === 0) return "even with your sale"
  return d > 0 ? `${usd(d)} more than you sold it for` : `${usd(-d)} less than you sold it for`
}
