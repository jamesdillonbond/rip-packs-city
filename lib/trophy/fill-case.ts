// lib/trophy/fill-case.ts
//
// "Fill my case" for a challenge entry (2026-11-08 weekend review). rrx69 spent
// ~80 minutes, opened the picker ~20 times and searched his own address 15 times,
// holding 15 eligible Dame editions, and stopped at 5 of 6; blaise_27 held 10 and
// left after 25 seconds at 2 of 6. One button now proposes the pieces that fill
// the remaining slots, and the owner confirms.
//
// The ORDER matches `fill_partial_challenge_cases` (the at-close fill Trevor asked
// for the same night): an edition not already in the case first, then the highest
// FMV, then the lowest serial. Unpriced pieces go last, never first.
//
// ⚠ OWNERSHIP, not just presence. A wallet_moments_cache row is the moment as of
// that wallet's last walk; a row the walk did NOT re-see may be a sold moment.
// A candidate counts only if its row was seen within a day of the wallet's newest
// row, OR it is LOCKED with a lock check in the last 14 days (a locked moment
// cannot leave the wallet). A wallet whose newest row is unknown offers only the
// locked branch. The route still re-checks every pick through `checkChallengePin`
// before writing it — this ranking is a proposal, never the gate.

export interface FillCandidateRow {
  wallet_address: string
  moment_id: string
  edition_key: string | null
  fmv_usd: number | string | null
  serial_number: number | null
  last_seen_at: string | null
  is_locked: boolean | null
  lock_checked_at: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const LOCK_FRESH_MS = 14 * DAY_MS

export function provablyHeld(
  row: FillCandidateRow,
  walletNewestMs: ReadonlyMap<string, number>,
  nowMs: number
): boolean {
  const newest = walletNewestMs.get(row.wallet_address)
  const seen = row.last_seen_at ? Date.parse(row.last_seen_at) : NaN
  if (newest != null && Number.isFinite(seen) && seen >= newest - DAY_MS) return true
  const lockChecked = row.lock_checked_at ? Date.parse(row.lock_checked_at) : NaN
  return row.is_locked === true && Number.isFinite(lockChecked) && lockChecked >= nowMs - LOCK_FRESH_MS
}

function fmvOf(row: FillCandidateRow): number | null {
  const n = typeof row.fmv_usd === "string" ? Number(row.fmv_usd) : row.fmv_usd
  return typeof n === "number" && Number.isFinite(n) ? n : null
}

/**
 * The candidates in fill order, de-duplicated by moment, excluding moments
 * already in the case and rows that cannot be shown to still be held.
 */
export function rankFillCandidates(
  rows: readonly FillCandidateRow[],
  opts: {
    pinnedMomentIds: ReadonlySet<string>
    pinnedEditions: ReadonlySet<string>
    walletNewestMs: ReadonlyMap<string, number>
    nowMs: number
  }
): FillCandidateRow[] {
  const seen = new Set<string>()
  const out: FillCandidateRow[] = []
  for (const r of rows) {
    const id = String(r.moment_id)
    if (seen.has(id) || opts.pinnedMomentIds.has(id)) continue
    if (!provablyHeld(r, opts.walletNewestMs, opts.nowMs)) continue
    seen.add(id)
    out.push(r)
  }
  return out.sort((a, b) => {
    const da = a.edition_key != null && opts.pinnedEditions.has(a.edition_key) ? 1 : 0
    const db = b.edition_key != null && opts.pinnedEditions.has(b.edition_key) ? 1 : 0
    if (da !== db) return da - db
    const fa = fmvOf(a)
    const fb = fmvOf(b)
    if (fa !== fb) {
      if (fa == null) return 1
      if (fb == null) return -1
      return fb - fa
    }
    return (a.serial_number ?? Number.MAX_SAFE_INTEGER) - (b.serial_number ?? Number.MAX_SAFE_INTEGER)
  })
}

/** The TS media URL every Top Shot pin already carries (passes the thumbnail allowlist). */
export function topShotThumbnail(momentId: string): string {
  return `https://assets.nbatopshot.com/media/${encodeURIComponent(momentId)}/image?width=512`
}
