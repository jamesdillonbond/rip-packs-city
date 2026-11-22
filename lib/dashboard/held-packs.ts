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
}

export interface HeldPacksTotal {
  /** Sealed packs held across every wallet that answered. */
  held: number
  /** …of which have a live ask. */
  listed: number
  /** Sum of the lowest live ask of each listed held pack, USD. */
  lowAskUsd: number
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
  let failed = 0
  for (const r of rows) {
    if (!r) { failed++; continue }
    held += num(r.count)
    listed += num(r.listed_count)
    lowAsk += num(r.floor_ask_usd)
  }
  return { held, listed, lowAskUsd: Math.round(lowAsk * 100) / 100, walletsFailed: failed }
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
  if (t.listed <= 0) return `${packs} · no live asks`
  const partial = t.walletsFailed > 0 ? " (some wallets didn't load)" : ""
  const coverage = t.listed < t.held ? `, ${t.listed.toLocaleString("en-US")} listed` : ""
  return `+ ${fmt(t.lowAskUsd)} in ${packs} at low ask${coverage}${partial}`
}
