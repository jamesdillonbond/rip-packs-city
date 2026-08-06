// lib/profile/saved-wallet-quota.ts
//
// Plan-cap arithmetic for saved wallets.
//
// THE BUG THIS EXISTS TO PREVENT: saved_wallets stores ONE ROW PER
// (user_id, wallet_addr, collection_id), so a single Dapper wallet lands 5 rows
// (Top Shot, All Day, Golazos, Pinnacle, UFC). Counting ROWS against
// feature_quotas.saved_wallets_max therefore reads 5 for a free user whose cap
// is 1 — blocking them immediately after their FIRST wallet, with a
// "Free plan supports 1 saved wallet" message that is true but misapplied.
// The cap is about PHYSICAL WALLETS, so it must be measured on distinct
// wallet_addr. This mirrors groupWalletsByAddress() on the dashboard, which
// already groups the same rows the same way for display.
//
// Kept in lib/ (not inlined in the routes) because BOTH write paths need it —
// /api/profile/saved-wallets POST and /api/profile/resolve-and-associate, the
// latter being the primary "Load my collection" path that had no cap check at
// all and so bypassed the limit entirely.

/** Minimal shape needed to count distinct wallets. */
export interface SavedWalletAddrRow {
  wallet_addr: string | null;
}

/**
 * Distinct physical wallets in a set of saved_wallets rows.
 * Addresses are compared case-insensitively — the DB stores lower-case, but a
 * caller that skipped normalization must not be able to double-count `0xAB`
 * and `0xab` and thereby inflate a user past their cap.
 */
export function countDistinctWallets(rows: readonly SavedWalletAddrRow[] | null | undefined): number {
  if (!rows) return 0;
  const set = new Set<string>();
  for (const r of rows) {
    const addr = r?.wallet_addr;
    if (typeof addr === "string" && addr.trim() !== "") set.add(addr.trim().toLowerCase());
  }
  return set.size;
}

/**
 * True when `candidate` is already one of the user's saved wallets, i.e. this
 * write is a RE-SAVE and must skip the cap (otherwise a user at their limit
 * could never refresh or re-associate the wallet they already own).
 */
export function walletAlreadySaved(
  rows: readonly SavedWalletAddrRow[] | null | undefined,
  candidate: string
): boolean {
  const want = candidate.trim().toLowerCase();
  if (want === "") return false;
  return (rows ?? []).some(
    (r) => typeof r?.wallet_addr === "string" && r.wallet_addr.trim().toLowerCase() === want
  );
}

/**
 * Decide whether adding `candidate` would exceed the plan cap.
 *
 * `maxAllowed` follows the checkFeatureQuota contract: null = unlimited.
 * Returns the numbers the caller needs for its 402 body so the message can
 * state the real count rather than a row count.
 */
export function evaluateSavedWalletCap(
  rows: readonly SavedWalletAddrRow[] | null | undefined,
  candidate: string,
  maxAllowed: number | null
): { allowed: boolean; distinctCount: number; isReSave: boolean } {
  const distinctCount = countDistinctWallets(rows);
  const isReSave = walletAlreadySaved(rows, candidate);
  if (isReSave || maxAllowed === null) {
    return { allowed: true, distinctCount, isReSave };
  }
  return { allowed: distinctCount < maxAllowed, distinctCount, isReSave };
}
