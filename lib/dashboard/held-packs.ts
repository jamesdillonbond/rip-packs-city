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
