// lib/allday-lock.ts
//
// Whale-safe All Day lock refresh, shared by the per-wallet route
// (/api/allday-lock-refresh) and the scheduled batch orchestrator
// (/api/cron/allday-lock-refresh-batch).
//
// All Day has no per-NFT isLocked() primitive like Top Shot / Pinnacle. Its
// lock mechanism moves locked moments to Dapper custodial infrastructure, so a
// locked moment DISAPPEARS from the wallet's on-chain collection. The signal is
// therefore a DIFF: everything in wallet_moments_cache that is NOT in the
// on-chain (unlocked) id set is locked.
//
// The naive single-shot GET_UNLOCKED_MOMENT_DETAILS trips Cadence computation
// limit 1110 on mega-wallets (40k+ moments), so this walks the paginated
// GET_UNLOCKED_MOMENT_DETAILS_RANGE in fixed windows and unions the results.
// lock_checked_at is ALWAYS stamped on every examined row (not just flips), so
// freshness advances even in the steady state where nothing changed.

import {
  GET_UNLOCKED_MOMENT_DETAILS_RANGE,
} from "@/lib/chains/flow/allday-cadence"

export const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"
const WINDOW = 1000 // getIDs()[start..start+WINDOW]; borrowNFT+field reads fit well under budget
const MAX_WINDOWS = 400 // hard cap = 400k moments/wallet, far beyond any real holder
const PER_CALL_TIMEOUT_MS = 20_000
const WRITE_CHUNK = 200

// One paginated RANGE call against Flow REST. Returns the unlocked (on-chain)
// moment ids in the window [start, start+count).
async function fetchUnlockedWindow(
  wallet: string,
  start: number,
  count: number,
): Promise<string[]> {
  const body = {
    script: btoa(GET_UNLOCKED_MOMENT_DETAILS_RANGE),
    arguments: [
      btoa(JSON.stringify({ type: "Address", value: wallet })),
      // Int Cadence args must be String-valued in Flow REST JSON.
      btoa(JSON.stringify({ type: "Int", value: String(start) })),
      btoa(JSON.stringify({ type: "Int", value: String(count) })),
    ],
  }
  const res = await fetch(FLOW_REST, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`Flow ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const raw = await res.text()
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
  // Cadence [[UInt64]] → { type:"Array", value:[ { value:[ {value:id}, ... ] } ] }
  const rows: Array<{ value: Array<{ value: string }> }> = decoded?.value ?? []
  const ids: string[] = []
  for (const row of rows) {
    const inner = row?.value
    if (Array.isArray(inner) && inner.length > 0) ids.push(String(inner[0].value))
  }
  return ids
}

// Walk every window until one comes back short (the final page), unioning the
// unlocked ids. Best-effort snapshot: getIDs() ordering is treated as stable
// across the few seconds of a single wallet's walk, same as the wallet-backfill
// paginated walks.
async function fetchAllUnlockedIds(wallet: string): Promise<Set<string>> {
  const unlocked = new Set<string>()
  for (let w = 0; w < MAX_WINDOWS; w++) {
    const ids = await fetchUnlockedWindow(wallet, w * WINDOW, WINDOW)
    for (const id of ids) unlocked.add(id)
    if (ids.length < WINDOW) break
  }
  return unlocked
}

export interface AllDayLockResult {
  wallet: string
  total_cached: number
  unlocked_onchain: number
  marked_locked: number
  marked_unlocked: number
}

// Refresh is_locked + lock_checked_at for one All Day wallet. Supabase client
// is injected so both the route (supabaseAdmin) and any caller can reuse it.
export async function refreshAllDayWalletLocks(
  wallet: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<AllDayLockResult> {
  const unlockedIds = await fetchAllUnlockedIds(wallet)

  const { data: cached, error: cacheErr } = await supabase
    .from("wallet_moments_cache")
    .select("moment_id, is_locked")
    .eq("wallet_address", wallet)
    .eq("collection_id", ALLDAY_COLLECTION_ID)
  if (cacheErr) throw new Error(cacheErr.message)

  const rows: Array<{ moment_id: unknown; is_locked: unknown }> = cached ?? []
  const toLock: string[] = []
  const toUnlock: string[] = []
  for (const r of rows) {
    const id = String(r.moment_id)
    const shouldLock = !unlockedIds.has(id)
    if (shouldLock && r.is_locked !== true) toLock.push(id)
    else if (!shouldLock && r.is_locked !== false) toUnlock.push(id)
  }

  const checkedAt = new Date().toISOString()

  for (let i = 0; i < toLock.length; i += WRITE_CHUNK) {
    await supabase
      .from("wallet_moments_cache")
      .update({ is_locked: true, lock_checked_at: checkedAt })
      .eq("wallet_address", wallet)
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("moment_id", toLock.slice(i, i + WRITE_CHUNK))
  }
  for (let i = 0; i < toUnlock.length; i += WRITE_CHUNK) {
    await supabase
      .from("wallet_moments_cache")
      .update({ is_locked: false, lock_checked_at: checkedAt })
      .eq("wallet_address", wallet)
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("moment_id", toUnlock.slice(i, i + WRITE_CHUNK))
  }

  // Stamp every examined row so freshness advances even when nothing flipped.
  // is_locked is deliberately not written here: this asserts "verified at".
  const allExamined = rows.map((r) => String(r.moment_id))
  for (let i = 0; i < allExamined.length; i += WRITE_CHUNK) {
    await supabase
      .from("wallet_moments_cache")
      .update({ lock_checked_at: checkedAt })
      .eq("wallet_address", wallet)
      .eq("collection_id", ALLDAY_COLLECTION_ID)
      .in("moment_id", allExamined.slice(i, i + WRITE_CHUNK))
  }

  return {
    wallet,
    total_cached: rows.length,
    unlocked_onchain: unlockedIds.size,
    marked_locked: toLock.length,
    marked_unlocked: toUnlock.length,
  }
}
