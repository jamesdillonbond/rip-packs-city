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
// ⛔ ABSENT ON CHAIN IS AMBIGUOUS: a SOLD moment is absent too, and this diff marks
// it locked like any other. Nothing here can tell the two apart; the sales table
// can. prune_allday_wmc_sold_away() (pg_cron, daily) deletes the rows this wallet
// sold after we last saw them, once a lock check after the sale found them absent.
// On 2026-09-29 2,535 sold moments across 22 wallets were sitting here as "locked".
//
// lock_checked_at is ALWAYS stamped on every examined row (not just flips), so
// freshness advances even in the steady state where nothing changed.
//
// ⚠ 2026-09-28 — THREE DEFECTS FIXED HERE, all measured on the live lane:
//
// 1. The cache read was one unpaged select, which PostgREST caps at 1,000 rows.
//    A wallet with more cached moments had an arbitrary 1,000 examined per walk
//    and the rest left stale, so its min(lock_checked_at) never advanced and
//    get_allday_lock_refresh_wallets (stalest-first) picked it EVERY tick. The
//    69,297-moment wallet 0xb770… was walked hourly to stamp 1,000 rows (a given
//    row checked about once every 69 h), and the whales took most of each tick.
//    The read now pages on the (wallet, collection, moment_id) unique key.
// 2. The walk used GET_UNLOCKED_MOMENT_DETAILS_RANGE in 1,000-id windows, which
//    borrows every NFT for fields this diff never reads. The IDs-only script
//    returns 20,000 ids per call; on that wallet the whole set came back in one
//    1.8 s call instead of ~46 calls at 1.0–4.9 s.
// 3. Every update was awaited without reading its error, and the caller counted
//    rows READ as rows written. Each write's error is now read; rows_stamped
//    counts only writes that landed, and write_errors pairs with it.

import { GET_UNLOCKED_MOMENT_IDS_RANGE } from "@/lib/chains/flow/allday-cadence"

export const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"
const WINDOW = 20_000 // getIDs()[start..start+WINDOW]; ids only, no borrowNFT
const MAX_WINDOWS = 50 // hard cap = 1M moments/wallet, far beyond any real holder
const PER_CALL_TIMEOUT_MS = 20_000
const READ_PAGE = 1_000 // PostgREST's row cap; the loop stops on an EMPTY page, not a short one
const WRITE_CHUNK = 200
const WRITE_CONCURRENCY = 4

/** Thrown when the caller's deadline would be crossed before the walk finishes. */
export class AllDayLockDeadlineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AllDayLockDeadlineError"
  }
}

// One paginated RANGE call against Flow REST. Returns the unlocked (on-chain)
// moment ids in the window [start, start+count).
async function fetchUnlockedWindow(
  wallet: string,
  start: number,
  count: number,
): Promise<string[]> {
  const body = {
    script: btoa(GET_UNLOCKED_MOMENT_IDS_RANGE),
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
  // Cadence [UInt64] → { type:"Array", value:[ { type:"UInt64", value:id }, ... ] }
  const rows: Array<{ value: string }> = decoded?.value ?? []
  return rows.map((row) => String(row?.value))
}

// Walk every window until one comes back short (the final page), unioning the
// unlocked ids. Best-effort snapshot: getIDs() ordering is treated as stable
// across the few seconds of a single wallet's walk, same as the wallet-backfill
// paginated walks. A window is not started once the deadline has passed.
async function fetchAllUnlockedIds(wallet: string, deadlineMs: number | undefined): Promise<Set<string>> {
  const unlocked = new Set<string>()
  for (let w = 0; w < MAX_WINDOWS; w++) {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new AllDayLockDeadlineError(`deadline reached after ${w} window(s)`)
    }
    const ids = await fetchUnlockedWindow(wallet, w * WINDOW, WINDOW)
    for (const id of ids) unlocked.add(id)
    if (ids.length < WINDOW) break
  }
  return unlocked
}

// Every cached All Day row for the wallet, paged on the unique key. A failed
// page throws: a partial list would stamp some rows and leave the rest stale
// while reporting the wallet as refreshed.
async function readCachedRows(
  wallet: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
): Promise<Array<{ moment_id: string; is_locked: unknown }>> {
  const out: Array<{ moment_id: string; is_locked: unknown }> = []
  let after: string | null = null
  for (;;) {
    let q = supabase
      .from("wallet_moments_cache")
      .select("moment_id, is_locked")
      .eq("wallet_address", wallet)
      .eq("collection_id", ALLDAY_COLLECTION_ID)
    if (after !== null) q = q.gt("moment_id", after)
    const { data, error } = await q.order("moment_id", { ascending: true }).limit(READ_PAGE)
    if (error) throw new Error(`wallet_moments_cache read: ${error.message}`)
    const page: Array<{ moment_id: unknown; is_locked: unknown }> = data ?? []
    if (page.length === 0) break
    for (const r of page) out.push({ moment_id: String(r.moment_id), is_locked: r.is_locked })
    after = String(page[page.length - 1].moment_id)
  }
  return out
}

interface WriteTally {
  written: number
  errors: number
  firstError: string | null
}

// Apply one update payload to `ids` in chunks, a few chunks in flight at once.
// Each chunk's error is read; only chunks that landed count as written.
async function writeChunks(
  wallet: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  ids: string[],
  payload: Record<string, unknown>,
  tally: WriteTally,
): Promise<void> {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += WRITE_CHUNK) chunks.push(ids.slice(i, i + WRITE_CHUNK))
  let next = 0
  async function worker() {
    while (next < chunks.length) {
      const chunk = chunks[next++]
      const { error } = await supabase
        .from("wallet_moments_cache")
        .update(payload)
        .eq("wallet_address", wallet)
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .in("moment_id", chunk)
      if (error) {
        tally.errors += 1
        if (tally.firstError === null) tally.firstError = String(error.message ?? error)
      } else {
        tally.written += chunk.length
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, chunks.length) }, worker))
}

export interface AllDayLockResult {
  wallet: string
  total_cached: number
  unlocked_onchain: number
  /** Flips whose write LANDED. */
  marked_locked: number
  marked_unlocked: number
  /** Rows whose lock_checked_at write LANDED (flips included). */
  rows_stamped: number
  /** Update chunks that failed; paired with rows_stamped, never folded into it. */
  write_errors: number
  first_write_error: string | null
}

// Refresh is_locked + lock_checked_at for one All Day wallet. Supabase client
// is injected so both the route (supabaseAdmin) and any caller can reuse it.
// `deadlineMs` (epoch ms) stops the on-chain walk from STARTING another window
// past it; the rows are written only after a complete walk.
export async function refreshAllDayWalletLocks(
  wallet: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  opts: { deadlineMs?: number } = {},
): Promise<AllDayLockResult> {
  const unlockedIds = await fetchAllUnlockedIds(wallet, opts.deadlineMs)
  const rows = await readCachedRows(wallet, supabase)

  const toLock: string[] = []
  const toUnlock: string[] = []
  const unchanged: string[] = []
  for (const r of rows) {
    const shouldLock = !unlockedIds.has(r.moment_id)
    if (shouldLock && r.is_locked !== true) toLock.push(r.moment_id)
    else if (!shouldLock && r.is_locked !== false) toUnlock.push(r.moment_id)
    else unchanged.push(r.moment_id)
  }

  const checkedAt = new Date().toISOString()
  const tally: WriteTally = { written: 0, errors: 0, firstError: null }

  await writeChunks(wallet, supabase, toLock, { is_locked: true, lock_checked_at: checkedAt }, tally)
  const lockedWritten = tally.written
  await writeChunks(wallet, supabase, toUnlock, { is_locked: false, lock_checked_at: checkedAt }, tally)
  const unlockedWritten = tally.written - lockedWritten
  // Stamp every other examined row so freshness advances even when nothing
  // flipped. is_locked is deliberately not written here: this asserts "verified at".
  await writeChunks(wallet, supabase, unchanged, { lock_checked_at: checkedAt }, tally)

  return {
    wallet,
    total_cached: rows.length,
    unlocked_onchain: unlockedIds.size,
    marked_locked: lockedWritten,
    marked_unlocked: unlockedWritten,
    rows_stamped: tally.written,
    write_errors: tally.errors,
    first_write_error: tally.firstError,
  }
}
