// lib/dashboard/held-packs.ts
//
// Sealed packs beside the aggregated wallet value (Trevor, 2026-11-21: "We should
// show the pack low ask total, when showing the aggregated wallet value").
//
// The account value (Portfolio FMV) sums held MOMENTS only; sealed packs never
// reached it. wallet_held_pack_value(p_wallet) already prices every held sealed
// pack (v2, 2026-11-13) — `floor_ask_usd` is the sum of the lowest live ask of each
// held pack and `listed_count` how many of them HAVE a live ask (a pack from a drop
// with no ask adds $0). This module combines those per-wallet answers and words
// the line. Pure — unit-tested in __tests__/dashboard-held-packs.test.ts.

export interface HeldPackValueRow {
  count?: number | null
  listed_count?: number | null
  floor_ask_usd?: number | string | null
  // wallet_held_pack_value v3 (2026-11-21, Trevor "Cap by references"): each ask counts up
  // to 3x its drop's best reference (last sale / rip EV / opened avg); a listed pack with
  // no reference is listed, not valued. A $1,000,000 ask on a never-sold one-of-one reward
  // pack had read as $1.14M of one wallet's sealed packs.
  capped_ask_count?: number | null
  capped_ask_usd?: number | string | null
  unreferenced_ask_count?: number | null
  // v4 (2026-11-25, Trevor: "show Sealed Packs totals here, with it counting into that
  // collection's total fmv"): the same held packs and capped asks, keyed by collection_id.
  by_collection?: Record<string, { packs?: number | null; capped_ask_n?: number | null; capped_ask_usd?: number | string | null }> | null
}

/** One collection's sealed packs in one wallet: how many, how many priced, their capped low ask. */
export interface CollectionPacks {
  packs: number
  listed: number
  usd: number
}

export interface HeldPacksTotal {
  /** Sealed packs held across every wallet that answered. */
  held: number
  /** …of which are valued at a (capped) live ask. */
  listed: number
  /** Sum of those asks, each capped at 3x its drop's best reference, USD. */
  lowAskUsd: number
  /** Listed packs with no sale, EV or opened average to price them — counted, never valued. */
  unpriced?: number
  /** Wallets whose read failed — when > 0 the total is PARTIAL. */
  walletsFailed: number
  /**
   * Per wallet address → per collection_id sealed packs (2026-11-25). A wallet whose read failed
   * is `null`; a wallet whose answer predates the per-collection split (an old cache row) is
   * absent — the tile then shows no pack line rather than a manufactured 0.
   */
  byWallet?: Record<string, Record<string, CollectionPacks> | null>
}

/** Pure: a wallet answer's per-collection split, or null when the answer carries none. */
export function packsByCollection(r: HeldPackValueRow | null | undefined): Record<string, CollectionPacks> | null {
  const bc = r?.by_collection
  if (!bc || typeof bc !== "object") return null
  const out: Record<string, CollectionPacks> = {}
  for (const [id, v] of Object.entries(bc)) {
    if (!v || typeof v !== "object") continue
    const packs = num(v.packs)
    if (packs <= 0) continue
    out[id] = { packs, listed: num(v.capped_ask_n), usd: Math.round(num(v.capped_ask_usd) * 100) / 100 }
  }
  return out
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : 0
  return Number.isFinite(n) ? n : 0
}

/** Combine per-wallet answers; `null` marks a wallet whose read failed. */
export function sumHeldPacks(rows: Array<HeldPackValueRow | null>): HeldPacksTotal {
  let held = 0
  let listed = 0
  let lowAsk = 0
  let unpriced = 0
  let failed = 0
  for (const r of rows) {
    if (!r) { failed++; continue }
    held += num(r.count)
    // v3 keys when present; a pre-v3 answer (raw asks) is still read as before
    const v3 = r.capped_ask_usd != null && r.capped_ask_count != null
    listed += num(v3 ? r.capped_ask_count : r.listed_count)
    lowAsk += num(v3 ? r.capped_ask_usd : r.floor_ask_usd)
    unpriced += num(r.unreferenced_ask_count)
  }
  return { held, listed, lowAskUsd: Math.round(lowAsk * 100) / 100, unpriced, walletsFailed: failed }
}

/**
 * The caption fragment for the aggregated value. Returns null when there is
 * nothing to say (no sealed packs). A failed read says so — it never renders a
 * $0 pack total, which a collector would read as "my packs are worth nothing".
 */
export function heldPacksCaption(
  t: HeldPacksTotal | null,
  failed: boolean,
  fmt: (usd: number) => string,
): string | null {
  if (failed || (t && t.walletsFailed > 0 && t.held === 0)) return "Sealed packs: couldn't load"
  if (!t || t.held <= 0) return null
  const packs = `${t.held.toLocaleString("en-US")} sealed pack${t.held === 1 ? "" : "s"}`
  const unpriced = (t.unpriced ?? 0) > 0
    ? `, ${(t.unpriced ?? 0).toLocaleString("en-US")} listed with no sale to price ${(t.unpriced ?? 0) === 1 ? "it" : "them"}`
    : ""
  if (t.listed <= 0) return `${packs} · no priced asks${unpriced}`
  const partial = t.walletsFailed > 0 ? " (some wallets didn't load)" : ""
  const coverage = t.listed < t.held ? `, ${t.listed.toLocaleString("en-US")} priced` : ""
  return `+ ${fmt(t.lowAskUsd)} in ${packs} at low ask${coverage}${unpriced}${partial}`
}

/**
 * The single wallet value (Trevor, 2026-11-22: "one number that encompasses everything in
 * the wallet. Keep it simple"): fresh-priced Moments + stale-priced Moments + sealed packs at
 * their capped low ask. Pack total is left out only when its read failed — the caller says so.
 */
export function walletTotalUsd(
  momentsFmv: number,
  staleFmv: number,
  packs: HeldPacksTotal | null,
  packsFailed: boolean,
): number {
  const packUsd = !packsFailed && packs ? packs.lowAskUsd : 0
  return Math.round(((momentsFmv || 0) + (staleFmv || 0) + packUsd) * 100) / 100
}

/** The only caption the single number keeps: a note when sealed packs couldn't be counted. */
export function walletTotalCaption(
  packs: HeldPacksTotal | null,
  packsFailed: boolean,
  /** The pack read is still in flight (measured 2026-11-22: ~9 s cold) — the figure is not final yet. */
  packsLoading = false,
): string | null {
  if (packsLoading && !packsFailed && !packs) return "Adding sealed packs…"
  if (packsFailed || (packs && packs.walletsFailed > 0 && packs.held === 0)) return "Sealed packs couldn't load — not included"
  if (packs && packs.walletsFailed > 0) return "Some wallets' sealed packs didn't load"
  return null
}

/**
 * The share card's single figure (page AND its OG image, 2026-11-22): every collection's FMV —
 * UFC (closed on Flow) included, so the snapshot's own `totalFmv` (which leaves closed markets
 * out) is used only when the per-collection rows are absent — plus sealed packs at capped low ask.
 */
export function shareWalletTotalUsd(
  perCollection: Array<{ fmv?: number | string | null }> | null | undefined,
  snapshotTotalFmv: number | string | null | undefined,
  packs: HeldPacksTotal | null,
  packsFailed: boolean,
): number {
  const rows = perCollection ?? []
  const moments = rows.length > 0
    ? rows.reduce((s, c) => s + (Number(c.fmv) || 0), 0)
    : Number(snapshotTotalFmv) || 0
  return walletTotalUsd(moments, 0, packs, packsFailed)
}
