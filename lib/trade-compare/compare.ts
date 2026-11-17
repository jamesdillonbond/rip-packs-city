// lib/trade-compare/compare.ts
//
// "What could these two collectors trade?" — the pure half of /trades/compare (2026-11-16,
// after a live read of thetradefloor.pages.dev; Trevor: "Keep going and working on this").
//
// Input: the DB's CANDIDATES (get_trade_compare — duplicates one wallet holds in an
// edition the other does not own) plus the CHAIN's answer for those candidates (held, locked,
// listed for sale). Output: per side, the editions with the copies that can actually move, and
// a Quick Trade — one Moment each way whose RPC FMVs are close.
//
// Rules built in (each one is a lesson, not a preference):
//   · Tradeable = held on chain now, NOT locked, NOT listed for sale on Top Shot. The cache's
//     lock flag was wrong on 121 of 137 "unlocked" rows in the 10-31 live test (#222), and a
//     listed Moment can be swapped but leaves a dead listing behind (topshot-listed.ts).
//   · KEEP ONE: a holder never gets told to trade away their last copy. At most owned − 1 copies
//     are offered, and the copy kept is the LOWEST serial (the one collectors value most); the
//     offered copies are the highest serials first.
//   · Prices are RPC FMV, never a lowest ask. thetradefloor called a $4.23-vs-$6.00 swap "even"
//     because it balanced two lowest asks ($7.40 vs $7.50), and a single $100,000 ask put a
//     side at $5.2M. A missing FMV is "not priced", never $0.
//   · The FMV shown is RPC's at any confidence (the Trade Block rule, 2026-11-04) with the
//     "from asks" marker where ask-derived; Quick Trade, which is a VERDICT ("close in value"),
//     pairs only CONFIDENTLY priced editions (the trade room's HIGH/MEDIUM rule). The tier never
//     leaves the server: the client sees fmv_usd, from_asks and the Quick Trade result.

import { isAskDerivedFmv } from "@/lib/fmv-basis"

export const CONFIDENT = new Set(["HIGH", "MEDIUM"])

/** A row of get_trade_compare's a_rows / b_rows. */
export interface CandidateRow {
  moment_id: string
  edition_key: string
  serial_number: number | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  image_url: string | null
  league: string | null
  fmv_usd: number | string | null
  fmv_confidence: string | null
  /** Every copy of the edition the holder has in RPC's index, locked or not. */
  owned: number
  /** Of those, how many RPC last saw locked (not candidates; the chain is not read for them). */
  cached_locked: number
}

export interface ChainState {
  /** moment_id -> held/locked, from readTopShotHoldings over the candidate ids. */
  holdings: Record<string, { held: boolean; locked: boolean | null }>
  /** Moment ids the holder has listed for sale on Top Shot right now. */
  listed: ReadonlySet<string>
}

export interface TradeCopy {
  moment_id: string
  serial_number: number | null
}

export interface CompareEdition {
  edition_key: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  league: string | null
  image_url: string | null
  /** RPC FMV at any confidence; null = not priced (never 0 for "unknown"). */
  fmv_usd: number | null
  /** The FMV is derived from asks (shown with the platform's "from asks" marker). */
  from_asks: boolean
  owned: number
  /** Copies that can move now, highest serial first, at most owned − 1. */
  tradeable: TradeCopy[]
  /** Candidate copies the chain says are locked, listed or gone (counted, not offered). */
  blocked: { locked: number; listed: number; gone: number }
}

export interface QuickItem {
  edition_key: string
  moment_id: string
  serial_number: number | null
  player_name: string | null
  set_name: string | null
  fmv_usd: number
}

export interface QuickTrade {
  /** What the first collector gives: one Moment, or two (a two-for-one). */
  a: QuickItem[]
  /** What the second collector gives. */
  b: QuickItem[]
  /** Σa − Σb, to the cent. */
  difference_usd: number
}

function num(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Group one side's candidates into editions and apply the chain's answer. An edition with no
 * tradeable copy left is dropped (it is not a candidate any more); its blocked copies are not
 * reported per edition then — the side's totals carry them.
 */
export function buildSide(rows: readonly CandidateRow[], chain: ChainState): { editions: CompareEdition[]; blocked: { locked: number; listed: number; gone: number }; confident: Set<string> } {
  const byEdition = new Map<string, CandidateRow[]>()
  for (const r of rows) {
    const k = String(r.edition_key)
    const list = byEdition.get(k)
    if (list) list.push(r)
    else byEdition.set(k, [r])
  }
  const sideBlocked = { locked: 0, listed: 0, gone: 0 }
  const confident = new Set<string>()
  const editions: CompareEdition[] = []
  for (const [edition_key, copies] of byEdition) {
    const first = copies[0]
    const blocked = { locked: 0, listed: 0, gone: 0 }
    const free: TradeCopy[] = []
    for (const c of copies) {
      const id = String(c.moment_id)
      const h = chain.holdings[id]
      if (!h || !h.held) blocked.gone++
      else if (h.locked !== false) blocked.locked++
      else if (chain.listed.has(id)) blocked.listed++
      else free.push({ moment_id: id, serial_number: c.serial_number ?? null })
    }
    sideBlocked.locked += blocked.locked
    sideBlocked.listed += blocked.listed
    sideBlocked.gone += blocked.gone
    // Copies held after the chain read: the index's count minus those that left.
    const heldNow = Math.max(0, Number(first.owned) - blocked.gone)
    const allowed = Math.max(0, Math.min(free.length, heldNow - 1))
    if (allowed === 0) continue
    // keep the LOWEST serial; offer the highest first (a missing serial sorts as the highest)
    free.sort((x, y) => (y.serial_number ?? Number.MAX_SAFE_INTEGER) - (x.serial_number ?? Number.MAX_SAFE_INTEGER))
    const tradeable = free.length > allowed ? free.slice(0, allowed) : free
    const fmv = num(first.fmv_usd)
    const conf = String(first.fmv_confidence ?? "").toUpperCase()
    if (fmv != null && CONFIDENT.has(conf)) confident.add(edition_key)
    editions.push({
      edition_key,
      player_name: first.player_name ?? null,
      set_name: first.set_name ?? null,
      tier: first.tier ?? null,
      series_number: first.series_number ?? null,
      league: first.league ?? null,
      image_url: first.image_url ?? null,
      fmv_usd: fmv,
      from_asks: fmv != null && isAskDerivedFmv(conf),
      owned: heldNow,
      tradeable,
      blocked,
    })
  }
  editions.sort((x, y) => (y.fmv_usd ?? -1) - (x.fmv_usd ?? -1) || x.edition_key.localeCompare(y.edition_key))
  return { editions, blocked: sideBlocked, confident }
}

/** Close enough to call a 1-for-1 "close in value": within $1, or within 10 % of the larger side. */
export function closeEnough(a: number, b: number): boolean {
  const diff = Math.abs(a - b)
  return diff <= 1 || diff <= 0.1 * Math.max(a, b)
}

/**
 * The Quick Trade: Moments each way, every one CONFIDENTLY priced, the two sides close in value —
 * one-for-one, or two-for-one in either direction (2026-11-16: one-for-one alone found nothing in
 * every live compare that day). Among qualifying trades the most valuable wins (by the smaller
 * side's total), ties to the one with fewer Moments, then to the closest. Two Moments on one side
 * are always two DIFFERENT editions (one copy per edition is offered). Null when nothing
 * qualifies; the page then says so rather than inventing one.
 */
export function quickTrade(
  a: readonly CompareEdition[],
  b: readonly CompareEdition[],
  aConfident: ReadonlySet<string>,
  bConfident: ReadonlySet<string>,
): QuickTrade | null {
  const priced = (eds: readonly CompareEdition[], ok: ReadonlySet<string>) =>
    eds
      .filter((e) => ok.has(e.edition_key) && e.fmv_usd != null && e.fmv_usd > 0 && e.tradeable.length > 0)
      .sort((x, y) => (x.fmv_usd as number) - (y.fmv_usd as number))
  const sa = priced(a, aConfident)
  const sb = priced(b, bConfident)
  if (!sa.length || !sb.length) return null

  type Pick = { ga: CompareEdition[]; gb: CompareEdition[]; floor: number; diff: number; n: number }
  let best: Pick | null = null
  const consider = (ga: CompareEdition[], gb: CompareEdition[]) => {
    const va = ga.reduce((t, e) => t + (e.fmv_usd as number), 0)
    const vb = gb.reduce((t, e) => t + (e.fmv_usd as number), 0)
    if (!closeEnough(va, vb)) return
    const cand: Pick = { ga, gb, floor: Math.min(va, vb), diff: Math.abs(va - vb), n: ga.length + gb.length }
    if (
      !best ||
      cand.floor > best.floor + 1e-9 ||
      (Math.abs(cand.floor - best.floor) <= 1e-9 && (cand.n < best.n || (cand.n === best.n && cand.diff < best.diff)))
    ) {
      best = cand
    }
  }

  // one-for-one: binary-search the nearest value on the other side
  const nearest = (sorted: CompareEdition[], v: number): number => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((sorted[mid].fmv_usd as number) < v) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  for (const ea of sa) {
    const at = nearest(sb, ea.fmv_usd as number)
    for (const j of [at - 1, at]) if (sb[j]) consider([ea], [sb[j]])
  }

  // two-for-one: for each single on one side, a two-pointer walk over pairs on the other
  const pairs = (two: CompareEdition[], one: CompareEdition[], twoIsA: boolean) => {
    if (two.length < 2) return
    for (const single of one) {
      const target = single.fmv_usd as number
      let i = 0
      let k = two.length - 1
      while (i < k) {
        const sum = (two[i].fmv_usd as number) + (two[k].fmv_usd as number)
        if (twoIsA) consider([two[k], two[i]], [single])
        else consider([single], [two[k], two[i]])
        if (sum < target) i++
        else k--
      }
    }
  }
  pairs(sa, sb, true)
  pairs(sb, sa, false)

  if (!best) return null
  const chosen = best as Pick
  const item = (e: CompareEdition): QuickItem => ({
    edition_key: e.edition_key,
    moment_id: e.tradeable[0].moment_id,
    serial_number: e.tradeable[0].serial_number,
    player_name: e.player_name,
    set_name: e.set_name,
    fmv_usd: e.fmv_usd as number,
  })
  const sum = (g: CompareEdition[]) => g.reduce((t, e) => t + (e.fmv_usd as number), 0)
  return { a: chosen.ga.map(item), b: chosen.gb.map(item), difference_usd: round2(sum(chosen.ga) - sum(chosen.gb)) }
}

/** Index coverage of one wallet: RPC's indexed count against the chain's getIDs() length. */
export type Coverage = { indexed: number; on_chain: number | null; complete: boolean | null }

export function coverage(indexed: number, onChain: number | null): Coverage {
  if (onChain == null) return { indexed, on_chain: null, complete: null }
  return { indexed, on_chain: onChain, complete: indexed >= onChain }
}
