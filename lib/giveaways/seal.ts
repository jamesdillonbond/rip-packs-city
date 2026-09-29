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
