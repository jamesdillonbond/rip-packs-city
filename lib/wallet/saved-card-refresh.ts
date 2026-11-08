// refreshSavedCardsForWallet — re-stamp every saved_wallets card for a wallet from
// wallet_moments_cache, right after a walker CHANGED that wallet's cache rows.
//
// 2026-11-07 (handoff claude/handoff-2026-11-08-new-signup-capped-nba-card.md): a
// new collector's NBA card read 50 while the cache held 880. At signup,
// resolve-and-associate stamps the cards from a 50-row first-paint pass; the deep
// multicollection backfill re-runs the same aggregate when IT finishes — but the
// Top Shot, Golazos and UFC walkers it dispatches are fire-and-forget, so that
// re-run can land before the walk does. Nothing else touched the card for ~6 h
// (reconcile_all_saved_wallet_stats skips wallets fresher than 360 min), so a
// collector's first hours showed the page cap. The walkers refreshed
// seeded_wallets stats on completion, never the saved cards; this closes that.
//
// Bounded: one indexed read of saved_wallets by wallet_addr (owners ≤ 25) and one
// aggregate per owner — the same RPC signup and the deep backfill already call.
// Never throws: a failed refresh leaves the card where the nightly reconcile
// will correct it, and is logged.

import { supabaseAdmin } from "@/lib/supabase"

const MAX_OWNERS = 25

export async function refreshSavedCardsForWallet(
  wallet: string,
  changedRows: number | undefined,
  // Injectable for tests.
  db: unknown = supabaseAdmin,
): Promise<{ owners: number; refreshed: number; error: string | null }> {
  // A walk that changed nothing cannot have moved a card. `undefined` = unknown → refresh.
  if (changedRows === 0) return { owners: 0, refreshed: 0, error: null }
  try {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (db as any)
      .from("saved_wallets")
      .select("user_id")
      .eq("wallet_addr", wallet)
      .limit(MAX_OWNERS * 8)
    if (error) {
      console.warn(`[saved-card-refresh] owner read failed for ${wallet}: ${error.message}`)
      return { owners: 0, refreshed: 0, error: error.message }
    }
    const owners = Array.from(
      new Set(((data ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter((u): u is string => !!u)),
    ).slice(0, MAX_OWNERS)
    let refreshed = 0
    let firstError: string | null = null
    for (const userId of owners) {
      // deno-lint-ignore no-explicit-any
      const { error: rpcError } = await (db as any).rpc("aggregate_saved_wallet_stats", {
        p_user_id: userId,
        p_wallet_addr: wallet,
      })
      if (rpcError) {
        firstError ??= rpcError.message
        console.warn(`[saved-card-refresh] aggregate failed for ${wallet}: ${rpcError.message}`)
      } else {
        refreshed++
      }
    }
    return { owners: owners.length, refreshed, error: firstError }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[saved-card-refresh] threw for ${wallet}: ${msg}`)
    return { owners: 0, refreshed: 0, error: msg }
  }
}
