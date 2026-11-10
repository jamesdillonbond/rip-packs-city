// lib/trophy/recent-buys.ts
//
// Bring a wallet's RECENT Top Shot purchases into wallet_moments_cache, verified
// on-chain, without a full five-collection walk (2026-11-10).
//
// Why: spitehouse stopped Dame Time at 5 of 6 while holding a sixth Lillard he
// had bought ~3 h after his wallet's last walk. The pin picker, the ownership
// gate (checkChallengePin), "Fill my case" and the admin at-close fill all read
// ONLY the cache, so the piece was invisible to every one of them.
//
// How: `get_unwalked_topshot_buys` lists Moments this wallet BOUGHT since its
// newest cache row (−1 h) that the cache does not hold — candidates only, a
// bought piece may have been resold or gifted. `readTopShotHoldings` asks the
// chain which of those it holds right now (the Cadence the lock-check cron runs).
// `record_verified_topshot_buys` writes ONLY ids in both sets, re-deriving the
// candidate list itself and taking names/tiers from `editions`.
//
// Callers: the fill route (before ranking), the picker-open sync route, and the
// hourly open-challenge cron. Never throws: a failed sync leaves the cache as it
// was (the stricter state) and reports why in `error`.

import { readTopShotHoldings } from "@/lib/giveaways/topshot-holdings"

export interface RecentBuysSync {
  wallet: string
  /** candidates found (bought since the last walk, not in the cache) */
  candidates: number
  /** of those, confirmed held on-chain */
  held: number
  /** rows the writer RETURNED as inserted — not rows attempted */
  added: number
  error: string | null
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** The one call this lane makes — satisfied by the service-role supabase client. */
export interface RpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

const FLOW_ADDR = /^0x[0-9a-f]{16}$/

export async function syncRecentTopShotBuys(
  db: RpcClient,
  wallet: string,
  fetchImpl: FetchLike = fetch,
): Promise<RecentBuysSync> {
  const out: RecentBuysSync = { wallet, candidates: 0, held: 0, added: 0, error: null }
  // A Solana or EVM address has no Top Shot collection to read.
  if (!FLOW_ADDR.test(wallet)) return out
  try {
    const cand = await db.rpc("get_unwalked_topshot_buys", { p_wallet: wallet, p_limit: 200 })
    if (cand.error) return { ...out, error: `candidates: ${cand.error.message}` }
    const ids = [
      ...new Set(
        ((cand.data ?? []) as { moment_id: unknown }[])
          .map((r) => (typeof r.moment_id === "string" ? r.moment_id : r.moment_id == null ? null : String(r.moment_id)))
          .filter((id): id is string => !!id && /^[0-9]{1,20}$/.test(id)),
      ),
    ]
    out.candidates = ids.length
    if (ids.length === 0) return out

    const holdings = await readTopShotHoldings(wallet, ids, fetchImpl)
    const held = ids.filter((id) => holdings[id]?.held)
    const locked = held.filter((id) => holdings[id]?.locked === true)
    out.held = held.length
    if (held.length === 0) return out

    const rec = await db.rpc("record_verified_topshot_buys", {
      p_wallet: wallet,
      p_held_ids: held,
      p_locked_ids: locked,
    })
    if (rec.error) return { ...out, error: `record: ${rec.error.message}` }
    const n = typeof rec.data === "number" ? rec.data : Number(rec.data)
    out.added = Number.isFinite(n) ? n : 0
    return out
  } catch (err) {
    return { ...out, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Sync every wallet in `wallets`, one at a time (each is one chain read). */
export async function syncRecentTopShotBuysForWallets(
  db: RpcClient,
  wallets: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<RecentBuysSync[]> {
  const results: RecentBuysSync[] = []
  for (const w of [...new Set(wallets)]) results.push(await syncRecentTopShotBuys(db, w, fetchImpl))
  return results
}
