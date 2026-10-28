// lib/insights/squeeze-check.ts
//
// The one read behind the wallet squeeze check — shared by `/api/public/insights/squeeze-check` (the
// /insights/squeeze-check page) and the concierge's `check_wallet_squeeze`, so both pick the same per-collection
// RPC and tell the same three states apart (NFL All Day joined 2026-10-27, Top Shot parity pass 10).
//
// ⛔ THREE STATES, NOT TWO. Each exposure RPC returns `total_moments` NULL for a wallet with no rows in
// wallet_moments_cache — which is BOTH "this wallet holds none of these" and "we have never scanned this wallet".
// Before this helper both surfaces rendered the second as the first ("0 moments" / "nothing cached"). The
// discriminator is wallet_backfill_state, written by the per-collection backfill on every scan:
//   - "indexed"      the RPC found moments
//   - "empty"        a TRUSTED scan (at or after SCAN_RECORD_TRUSTED_FROM) found 0 moments in this collection.
//                    Copy says what the SCAN found, never what the wallet holds: an empty walk and a failed
//                    collection borrow both return [] (wallet-backfill-helpers.ts, empty-scan guard).
//   - "not_indexed"  no scan on record (or a scan found moments the cache does not hold yet)
//   - "unknown"      the state read failed — we say we could not tell, never "empty"
//
// Server-only: imports nothing client-side, and callers pass their own service-role client.

import { boundedRead } from "@/lib/api/bounded-read"
import { SQUEEZE_SOURCES } from "@/lib/insights/squeeze-board"
import type { SqueezeCollection } from "@/lib/insights/squeeze-collections"

export const SQUEEZE_CHECK_RPC: Record<SqueezeCollection, string> = {
  "nba-top-shot": "get_wallet_squeeze_exposure",
  "nfl-all-day": "get_allday_wallet_squeeze_exposure",
}

/**
 * Before 70d288a20 (2026-10-27 07:49 PT) a FAILED walk was recorded as a scan that found 0 (29 Flow 429s on
 * 10-26 alone), so an older found=0 row is not evidence of anything: it reads "not_indexed" and is re-queued.
 * Measured at the change: 93 of 103 All Day and 11 of 14 Top Shot found=0 rows with no cached moments predate it.
 */
export const SCAN_RECORD_TRUSTED_FROM = "2026-10-27T14:49:25Z"

export type SqueezeIndexState = "indexed" | "empty" | "not_indexed" | "unknown"

export interface SqueezeCheckRead {
  /** The RPC this read used — so a caller reports its source without indexing the map itself. */
  rpc: string
  /** Set when the exposure RPC itself failed — the caller renders "unavailable", never a state. */
  error: unknown | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  summary: any
  index_state: SqueezeIndexState | null
  /** When the backfill last scanned this wallet for this collection (null when never, or unread). */
  last_scanned_at: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readSqueezeCheck(db: any, wallet: string, collection: SqueezeCollection, label: string): Promise<SqueezeCheckRead> {
  const rpc = SQUEEZE_CHECK_RPC[collection] // collection is the closed SqueezeCollection union, never raw input
  const { data, error } = await boundedRead(db.rpc(rpc, { p_wallet: wallet }), `${label}/${rpc}`)
  if (error) return { rpc, error, summary: null, index_state: null, last_scanned_at: null }

  if (Number(data?.total_moments) > 0) {
    return { rpc, error: null, summary: data, index_state: "indexed", last_scanned_at: null }
  }

  const st = await boundedRead(
    db
      .from("wallet_backfill_state")
      .select("last_scanned_at, last_found_count")
      .eq("wallet_address", wallet)
      .eq("collection_id", SQUEEZE_SOURCES[collection].collectionId)
      .maybeSingle(),
    `${label}/wallet_backfill_state`,
  )
  if (st.error) return { rpc, error: null, summary: data ?? null, index_state: "unknown", last_scanned_at: null }
  const row = st.data as { last_scanned_at: string | null; last_found_count: number | null } | null
  if (!row || !row.last_scanned_at) {
    return { rpc, error: null, summary: data ?? null, index_state: "not_indexed", last_scanned_at: null }
  }
  // A scan that FOUND moments the cache does not hold is not "holds nothing" — the cache is behind the scan.
  // A found=0 record from before the scan-record fix may be a failed walk: not "empty" either.
  const trusted = Date.parse(row.last_scanned_at) >= Date.parse(SCAN_RECORD_TRUSTED_FROM)
  const state: SqueezeIndexState = row.last_found_count === 0 && trusted ? "empty" : "not_indexed"
  return { rpc, error: null, summary: data ?? null, index_state: state, last_scanned_at: row.last_scanned_at }
}

export interface WalletScanState {
  index_state: SqueezeIndexState
  /** The newest scan on record for this wallet, any collection (null when never, or unread). */
  last_scanned_at: string | null
}

/**
 * The same three states for a WHOLE wallet (every collection) — the Top Collector Report's question, where a
 * report built from zero cache rows would otherwise publish "0 rookie editions held" for a wallet we never read
 * (2026-10-28). `hasAnyCachedMoments` comes from the caller's own read (the report's cross-collection rollup);
 * this only runs when that read found none.
 *   - "empty": every scan on record is trusted and found 0 — never "the wallet holds nothing", only "our scan found none"
 *   - "not_indexed": no scan on record, or any scan that found moments / predates the scan-record fix
 *   - "unknown": the state read failed
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readWalletScanState(db: any, wallet: string, hasAnyCachedMoments: boolean, label: string): Promise<WalletScanState> {
  if (hasAnyCachedMoments) return { index_state: "indexed", last_scanned_at: null }
  const st = await boundedRead(
    db.from("wallet_backfill_state").select("last_scanned_at, last_found_count").eq("wallet_address", wallet).limit(50),
    `${label}/wallet_backfill_state`,
  )
  if (st.error) return { index_state: "unknown", last_scanned_at: null }
  const rows = ((st.data ?? []) as Array<{ last_scanned_at: string | null; last_found_count: number | null }>).filter((r) => r.last_scanned_at)
  if (rows.length === 0) return { index_state: "not_indexed", last_scanned_at: null }
  const newest = rows.map((r) => r.last_scanned_at as string).sort().at(-1) ?? null
  const trustedFrom = Date.parse(SCAN_RECORD_TRUSTED_FROM)
  const allTrustedEmpty = rows.every((r) => r.last_found_count === 0 && Date.parse(r.last_scanned_at as string) >= trustedFrom)
  return { index_state: allTrustedEmpty ? "empty" : "not_indexed", last_scanned_at: newest }
}
