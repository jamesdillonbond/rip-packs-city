// lib/giveaways/seal.ts
//
// Sealing a giveaway drop: shuffle the pool into packs, and commit to that
// assignment with a hash published BEFORE claims open.
//
// Why a commitment. The admin (the drop's sponsor) knows the pool. Without a
// published hash they could, after seeing who claimed, swap the good moment into
// a friend's pack. With it, the assignment is fixed at sealing: after the drop
// closes the salt and the manifest are published, and anyone can recompute
//
//     sha256( salt + "|" + manifest )
//
// and check it equals the hash that was shown while claims were open.
// Which pack a claimer receives is a separate uniform draw over the unclaimed
// packs, made in the database at claim time (claim_giveaway_pack).
//
// The manifest format is part of the public contract — changing it breaks every
// published verification — so it is pinned by __tests__/giveaways-seal.test.ts:
//
//     "1:<id>,<id>,<id>;2:<id>,<id>,<id>;…"   packs ascending, moments in slot order

import { createHash, randomBytes, randomInt } from "node:crypto"

export interface PoolMoment {
  moment_id: string
  fmv_usd: number | null
}

export interface PackAssignment {
  moment_id: string
  pack_no: number
  slot: number
}

export interface SealResult {
  assignments: PackAssignment[]
  manifest: string
  salt: string
  hash: string
}

/** Fisher–Yates with a CSPRNG. Returns a new array. */
export function shuffle<T>(items: readonly T[], rand: (maxExclusive: number) => number = randomInt): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = rand(i + 1)
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** Deal an (already shuffled) list into `packCount` packs of `perPack`. */
export function dealIntoPacks(momentIds: readonly string[], packCount: number, perPack: number): PackAssignment[] {
  if (!Number.isInteger(packCount) || packCount < 1) throw new Error("packCount must be a positive integer")
  if (!Number.isInteger(perPack) || perPack < 1) throw new Error("perPack must be a positive integer")
  if (momentIds.length !== packCount * perPack) {
    throw new Error(`pool has ${momentIds.length} moments; ${packCount} packs of ${perPack} need ${packCount * perPack}`)
  }
  if (new Set(momentIds).size !== momentIds.length) throw new Error("pool contains a duplicate moment")
  return momentIds.map((moment_id, i) => ({
    moment_id,
    pack_no: Math.floor(i / perPack) + 1,
    slot: (i % perPack) + 1,
  }))
}

/** The canonical manifest string. Order-independent in its input. */
export function manifestOf(assignments: readonly PackAssignment[]): string {
  const byPack = new Map<number, PackAssignment[]>()
  for (const a of assignments) {
    const list = byPack.get(a.pack_no) ?? []
    list.push(a)
    byPack.set(a.pack_no, list)
  }
  return [...byPack.keys()]
    .sort((a, b) => a - b)
    .map((p) => {
      const ids = byPack
        .get(p)!
        .slice()
        .sort((a, b) => a.slot - b.slot)
        .map((a) => a.moment_id)
      return `${p}:${ids.join(",")}`
    })
    .join(";")
}

export function commitmentHash(salt: string, manifest: string): string {
  return createHash("sha256").update(`${salt}|${manifest}`, "utf8").digest("hex")
}

export function verifyCommitment(salt: string, manifest: string, hash: string): boolean {
  return commitmentHash(salt, manifest) === hash.toLowerCase()
}

/** Shuffle, deal and commit. `salt` and `rand` are injectable for tests only. */
export function sealPool(
  momentIds: readonly string[],
  packCount: number,
  perPack: number,
  opts: { salt?: string; rand?: (maxExclusive: number) => number } = {},
): SealResult {
  const shuffled = shuffle(momentIds, opts.rand)
  const assignments = dealIntoPacks(shuffled, packCount, perPack)
  const manifest = manifestOf(assignments)
  const salt = opts.salt ?? randomBytes(32).toString("hex")
  return { assignments, manifest, salt, hash: commitmentHash(salt, manifest) }
}

/**
 * How a sealed pool is dealt into packs (Trevor, 2026-11-08: moments "randomized
 * and shuffled as they're stuffed into packs for fairness of who receives what").
 *
 *   random   — one Fisher–Yates shuffle of the whole pool, dealt in order. Every
 *              arrangement is equally likely, so one pack CAN hold every top
 *              Moment while another holds only the cheapest.
 *   balanced — the pool is ranked by FMV (highest first, ties by moment id in
 *              code-point order) and cut into `perPack` value bands of
 *              `packCount` Moments each. Every pack gets exactly ONE Moment from
 *              each band, chosen by a CSPRNG shuffle inside the band: band 1 (the
 *              top `packCount` Moments) fills slot 1 of every pack, band 2 slot 2,
 *              and so on. No pack can hold two top-band Moments, and the gap
 *              between the best and worst pack is as small as a fixed pool allows.
 *
 * Either way the seal fingerprint commits to the result, and the database
 * re-checks the balanced property at seal (seal_giveaway_drop_dealt), so the
 * public page's description of the deal is enforced, not just claimed.
 */
export type DealMode = "random" | "balanced"

export const DEAL_MODES: readonly DealMode[] = ["random", "balanced"]

export function isDealMode(v: unknown): v is DealMode {
  return v === "random" || v === "balanced"
}

/** Highest FMV first; ties broken by moment id in code-point order (Postgres COLLATE "C"). */
export function rankByValue<T extends PoolMoment>(moments: readonly T[]): T[] {
  return moments.slice().sort((a, b) => {
    const av = a.fmv_usd ?? -Infinity
    const bv = b.fmv_usd ?? -Infinity
    if (av !== bv) return bv - av
    return a.moment_id < b.moment_id ? -1 : a.moment_id > b.moment_id ? 1 : 0
  })
}

/**
 * The balanced deal: value bands, one per slot, shuffled within the band.
 * Refuses an unpriced Moment — a band needs a value to rank by.
 */
export function dealBalanced(
  moments: readonly PoolMoment[],
  packCount: number,
  perPack: number,
  rand: (maxExclusive: number) => number = randomInt,
): PackAssignment[] {
  if (!Number.isInteger(packCount) || packCount < 1) throw new Error("packCount must be a positive integer")
  if (!Number.isInteger(perPack) || perPack < 1) throw new Error("perPack must be a positive integer")
  if (moments.length !== packCount * perPack) {
    throw new Error(`pool has ${moments.length} moments; ${packCount} packs of ${perPack} need ${packCount * perPack}`)
  }
  if (new Set(moments.map((m) => m.moment_id)).size !== moments.length) throw new Error("pool contains a duplicate moment")
  if (moments.some((m) => m.fmv_usd == null || !Number.isFinite(m.fmv_usd))) throw new Error("a balanced deal needs every moment priced")
  const ranked = rankByValue(moments)
  const out: PackAssignment[] = []
  for (let band = 0; band < perPack; band++) {
    const members = shuffle(ranked.slice(band * packCount, (band + 1) * packCount), rand)
    members.forEach((m, i) => out.push({ moment_id: m.moment_id, pack_no: i + 1, slot: band + 1 }))
  }
  return out
}

/** Deal by mode. `random` is the original v1 deal, unchanged. */
export function dealByMode(
  moments: readonly PoolMoment[],
  packCount: number,
  perPack: number,
  mode: DealMode,
  rand: (maxExclusive: number) => number = randomInt,
): PackAssignment[] {
  if (mode === "balanced") return dealBalanced(moments, packCount, perPack, rand)
  return dealIntoPacks(
    shuffle(
      moments.map((m) => m.moment_id),
      rand,
    ),
    packCount,
    perPack,
  )
}

/** Shuffle by mode, deal and commit. `salt` and `rand` are injectable for tests only. */
export function sealPoolDealt(
  moments: readonly PoolMoment[],
  packCount: number,
  perPack: number,
  mode: DealMode,
  opts: { salt?: string; rand?: (maxExclusive: number) => number } = {},
): SealResult {
  const assignments = dealByMode(moments, packCount, perPack, mode, opts.rand)
  const manifest = manifestOf(assignments)
  const salt = opts.salt ?? randomBytes(32).toString("hex")
  return { assignments, manifest, salt, hash: commitmentHash(salt, manifest) }
}

export interface PackSpread {
  /** Over the simulated deals: the typical (median) value of the WORST and the BEST pack. */
  typical_low_usd: number
  typical_high_usd: number
  /** The most extreme worst and best pack seen across the simulations. */
  worst_low_usd: number
  worst_high_usd: number
  trials: number
}

/**
 * How far apart pack values land under a deal mode, by simulation — the admin
 * preview, not a guarantee. Null when the pool doesn't fit the pack shape or a
 * moment is unpriced (a spread with a hole in it is not a spread).
 */
export function simulatePackSpread(
  fmvs: readonly (number | null)[],
  packCount: number,
  perPack: number,
  mode: DealMode,
  trials = 400,
  rand: (maxExclusive: number) => number = (n) => Math.floor(Math.random() * n),
): PackSpread | null {
  if (!(packCount >= 1 && perPack >= 1) || fmvs.length !== packCount * perPack) return null
  if (fmvs.some((v) => v == null || !Number.isFinite(v))) return null
  const moments: PoolMoment[] = fmvs.map((v, i) => ({ moment_id: String(i).padStart(6, "0"), fmv_usd: v as number }))
  const lows: number[] = []
  const highs: number[] = []
  for (let t = 0; t < trials; t++) {
    const totals = new Array<number>(packCount).fill(0)
    for (const a of dealByMode(moments, packCount, perPack, mode, rand)) totals[a.pack_no - 1] += Number(moments[Number(a.moment_id)].fmv_usd)
    lows.push(Math.min(...totals))
    highs.push(Math.max(...totals))
  }
  const median = (xs: number[]) => {
    const s = xs.slice().sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
  }
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    typical_low_usd: round(median(lows)),
    typical_high_usd: round(median(highs)),
    worst_low_usd: round(Math.min(...lows)),
    worst_high_usd: round(Math.max(...highs)),
    trials,
  }
}

export interface PackValueSummary {
  /** Sum of the FMVs that exist. */
  pool_fmv_usd: number
  /** Moments with no FMV — the pool total does NOT include them. */
  unpriced_count: number
  /** Only when every moment is priced; a pack total with a hole in it is not a pack value. */
  mean_pack_usd: number | null
  median_pack_usd: number | null
  best_pack_usd: number | null
}

/**
 * Pack values for the public page. The three per-pack figures are withheld
 * (null) unless EVERY moment has an FMV: a pack whose total silently skipped an
 * unpriced moment would publish a number that is not that pack's value.
 * Publishing them reveals nothing about which pack is which.
 */
export function summarizePackValues(
  moments: readonly (PoolMoment & { pack_no: number | null })[],
): PackValueSummary {
  let pool = 0
  let unpriced = 0
  const packs = new Map<number, number>()
  for (const m of moments) {
    if (m.fmv_usd == null || !Number.isFinite(m.fmv_usd)) {
      unpriced += 1
      continue
    }
    pool += m.fmv_usd
    if (m.pack_no != null) packs.set(m.pack_no, (packs.get(m.pack_no) ?? 0) + m.fmv_usd)
  }
  const round = (n: number) => Math.round(n * 100) / 100
  const sealed = moments.length > 0 && moments.every((m) => m.pack_no != null)
  if (unpriced > 0 || !sealed || packs.size === 0) {
    return { pool_fmv_usd: round(pool), unpriced_count: unpriced, mean_pack_usd: null, median_pack_usd: null, best_pack_usd: null }
  }
  const values = [...packs.values()].sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  const median = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2
  return {
    pool_fmv_usd: round(pool),
    unpriced_count: 0,
    mean_pack_usd: round(pool / values.length),
    median_pack_usd: round(median),
    best_pack_usd: round(values[values.length - 1]),
  }
}

/** NY GBL § 369-e / FL § 849.094: registration + bond above this total prize value. */
export const PRIZE_VALUE_CAP_USD = 5000
