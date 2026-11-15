// lib/wallet/wallet-owner.ts
//
// ONE rule for "whose wallet is this?", shared by every reader that has to
// pick a single owner from `saved_wallets` (2026-11-14).
//
// Anyone can save any address, so a `saved_wallets` row is NOT proof of
// ownership. The rule (known-issues #176, 2026-10-10):
//   1. a user who VERIFIED the address owns it;
//   2. otherwise the user who saved it FIRST (lowest row id) owns it.
// Nobody can become the first saver after the fact, and verification has had
// no live source since ~08-28 (#59), so "verified only" would lock almost
// everyone out of their own data.
//
// Callers: lib/auth/owner-key-guard.ts (private reads/writes keyed by an
// address) and lib/profile/public-profile.ts (which wallets a collector's
// PUBLIC Portfolio FMV may sum: a wallet someone else owns is never published
// as yours).

export type SavedWalletClaim = {
  id?: unknown
  user_id?: unknown
  verified_at?: unknown
}

/** The owning user ids for ONE address's claim rows: every verifier, else the
 *  first saver. Empty when no row carries a user id. */
export function ownersOfAddress(rows: readonly SavedWalletClaim[]): string[] {
  const claimed = rows.filter((r) => typeof r?.user_id === "string")
  if (claimed.length === 0) return []
  const verified = claimed.filter((r) => r.verified_at != null).map((r) => r.user_id as string)
  if (verified.length > 0) return [...new Set(verified)]
  const idOf = (r: SavedWalletClaim) => {
    const n = Number(r.id)
    return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY
  }
  const first = claimed.reduce((a, b) => (idOf(b) < idOf(a) ? b : a))
  return [first.user_id as string]
}
