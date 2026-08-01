// Pure aggregation helpers for the /dashboard portfolio header.
//
// Extracted verbatim from app/dashboard/page.tsx (the ~2,260-line monolith that
// NEITHER coverage gate measures) so the reduction/grouping logic behind the
// headline numbers — total moments, total FMV, the STALE-confidence footnote,
// the active-collection count, and the one-card-per-physical-wallet grouping —
// lives on the primary ratchet and is unit-tested. Bodies are byte-for-byte the
// originals; the page imports these and calls them from its useMemo blocks.
//
// Input types are structural (only the fields the math reads) so this module is
// self-contained and does not import the page.

/** Minimal shape of a per-collection stats row (get_wallet_collection_stats). */
export interface WalletStatRow {
  collection_id: string | null
  moment_count?: number | null
  fmv_total?: number | null
  fmv_stale_total?: number | null
  stale_count?: number | null
}

/** statsByWallet: address -> its per-collection stats rows. */
export type StatsByWallet = Record<string, WalletStatRow[]>

function allRows(statsByWallet: StatsByWallet): WalletStatRow[] {
  return Object.values(statsByWallet).flat()
}

/** Total moments across every wallet/collection. */
export function sumMoments(statsByWallet: StatsByWallet): number {
  return allRows(statsByWallet).reduce((s, r) => s + (r.moment_count ?? 0), 0)
}

/** Headline FMV total (fresh-confidence). */
export function sumFmv(statsByWallet: StatsByWallet): number {
  return allRows(statsByWallet).reduce((s, r) => s + (r.fmv_total ?? 0), 0)
}

/** STALE-confidence FMV — excluded from the headline, surfaced as a footnote so
 * it isn't silently lost. */
export function sumStaleFmv(statsByWallet: StatsByWallet): number {
  return allRows(statsByWallet).reduce((s, r) => s + (r.fmv_stale_total ?? 0), 0)
}

/** Count of editions whose price is stale. */
export function sumStaleCount(statsByWallet: StatsByWallet): number {
  return allRows(statsByWallet).reduce((s, r) => s + (r.stale_count ?? 0), 0)
}

/** Number of distinct collections the collector actually holds (moment_count > 0). */
export function countActiveCollections(statsByWallet: StatsByWallet): number {
  const ids = new Set<string>()
  for (const stats of Object.values(statsByWallet)) {
    for (const s of stats) {
      if ((s.moment_count ?? 0) > 0 && s.collection_id) ids.add(s.collection_id)
    }
  }
  return ids.size
}

/** Minimal shape a wallet row needs to be grouped by physical address. */
export interface GroupableWallet {
  wallet_addr: string
  nickname?: string | null
  verified_at?: string | null
}

export interface WalletGroup<T> {
  addr: string
  rows: T[]
  nickname: string | null
  verifiedAt: string | null
}

/** Group saved_wallets by physical wallet address — one entry per unique
 * address, carrying the first non-empty nickname / verified_at found. */
export function groupWalletsByAddress<T extends GroupableWallet>(wallets: T[]): WalletGroup<T>[] {
  const map = new Map<string, WalletGroup<T>>()
  for (const w of wallets) {
    const key = w.wallet_addr.toLowerCase()
    const existing = map.get(key)
    if (existing) {
      existing.rows.push(w)
      if (!existing.nickname && w.nickname) existing.nickname = w.nickname
      if (!existing.verifiedAt && w.verified_at) existing.verifiedAt = w.verified_at
    } else {
      map.set(key, {
        addr: w.wallet_addr,
        rows: [w],
        nickname: w.nickname ?? null,
        verifiedAt: w.verified_at ?? null,
      })
    }
  }
  return Array.from(map.values())
}
