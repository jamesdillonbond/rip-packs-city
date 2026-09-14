import { supabaseAdmin } from "@/lib/supabase"

// Delete-not-seen for wallet_moments_cache.
//
// This lives in its own module, NOT in wallet-backfill-helpers, for the same
// reason wmc-chunk-upsert does: the Top Shot route's test suite
// (__tests__/api-wallet-backfill-deep.test.ts) mocks wallet-backfill-helpers
// wholesale, so a delete imported through that module would be a STUB on the
// Top Shot path — the one collection with the confirmed phantom-holdings case.
// Importing from here puts the real implementation on every caller.

// Keyset paging (2026-08-30). These reads used to page with LIMIT/OFFSET on
// ORDER BY moment_id, so page k re-walked the first k*1000 index entries: a
// 154k-row whale cost ~12M index-entry visits to load once (O(n²)), and the
// pgss diff on the 13:57–14:13Z storm showed this one statement shape at 520
// calls / 2,498 s / 2.7M buffer hits in 16 min. Paging on `moment_id > last`
// over the unique (wallet_address, collection_id, moment_id) index makes every
// page an O(page) index-only range scan (1,122 buffers per 1,000 rows measured
// on the whale). moment_id is text and both ORDER BY and the cursor compare use
// the column's own collation, so the cursor is exact. The deterministic-order
// argument from 2026-08-16 (snapshot-institutional-wallets) still holds and is
// now also what makes the cursor correct.
//
// Fails OPEN with whatever it has read so far. For the delete below that is the
// safe direction: toDelete is a SUBSET of what this returns, so a truncated read
// can only under-delete (phantoms linger one more pass), never over-delete.
export async function loadCachedMomentIds(wallet: string, collectionUuid: string): Promise<Set<string>> {
  const ids = new Set<string>()
  const PAGE = 1000
  let after: string | null = null
  while (true) {
    // deno-lint-ignore no-explicit-any
    let q = (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .select("moment_id")
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
    if (after != null) q = q.gt("moment_id", after)
    const { data, error } = await q.order("moment_id", { ascending: true }).limit(PAGE)
    if (error) {
      console.warn(`[wallet-backfill] cached-id read failed: ${error.message}`)
      return ids
    }
    const rows = (data ?? []) as Array<{ moment_id: string }>
    for (const r of rows) ids.add(String(r.moment_id))
    if (rows.length < PAGE) break
    after = String(rows[rows.length - 1].moment_id)
  }
  return ids
}

export interface UnseenDeleteOutcome {
  deleted: number
  skippedReason?: string
  error?: string
}

/**
 * Delete wmc rows for (wallet, collection) whose moment_id is NOT in the set the
 * completing pass actually observed. This is the ONLY safe way to remove a moment
 * the wallet no longer holds.
 *
 * WHY THIS EXISTS. Nothing else deletes a wmc row when a moment LEAVES a wallet:
 * the ingest path only ever upserts, and the sole cleanup is prune_stale_wmc()
 * (pg_cron rpc-weekly-wmc-prune, Sundays) deleting rows whose last_seen_at is
 * older than 14 days. So a sold or transferred moment lingers for up to 14 days
 * plus up to 7 more until the weekly run — a ~14–21 day window in which the
 * dashboard, the /share card and saved_wallets.cached_moment_count all OVERCOUNT
 * the user's holdings. Confirmed live 2026-09-14 on 0x0d79d58c5fe83cdc: a forced
 * complete Top Shot pass saw 1,109 moments against 1,159 cached rows.
 *
 * WHY NOT last_seen_at. upsert_wmc_batch is change-detecting: its ON CONFLICT DO
 * UPDATE fires only when edition_key/serial_number changed OR last_seen_at is
 * already older than 24h. A pass that re-confirms a moment inside that window
 * writes nothing and does NOT advance last_seen_at, so a confirmed row and a
 * departed row carry identical timestamps. Measured 2026-09-14 on wallet
 * 0xba1a13299beb4b19 (All Day): a complete pass found 100 and wrote 0. A prune
 * keyed on "last_seen older than this pass" would have deleted all 100 real,
 * currently-held moments. The observed id-set is the only authority, and it
 * exists only inside the backfill — which is also why this cannot be a DB-only
 * pg_cron job, and why one must not be built.
 *
 * SAFETY CONTRACT — the caller MUST guarantee all of these before calling:
 *   1. The pass is COMPLETE (walked the wallet's whole holdings). Never on a
 *      soft-deadline / paginated-partial / safety-ceiling / timeout / error /
 *      skip exit — those have seen only a prefix of the wallet.
 *   2. `observedIds` is NON-EMPTY. A zero-length scan is never a delete trigger:
 *      an empty result is indistinguishable from a degraded read (a nil
 *      capability borrow returns [] exactly like an empty wallet). Genuinely
 *      emptied wallets stay with the 14-day prune_stale_wmc() backstop.
 *   3. For All Day, `observedIds` INCLUDES the studio (locked) moment ids AND the
 *      studio walk succeeded. All Day has no on-chain locking contract, so a
 *      locked moment is legitimately absent from getIDs(); deleting on a degraded
 *      custody walk would remove real holdings. If studio degraded, do NOT call.
 *   4. `observedIds` is built BEFORE any skip-cached filter. A skipped row was
 *      still observed; treating it as unseen deletes exactly what the skip
 *      was protecting.
 *
 * Defensive cap: if the diff would delete >90% of cached rows AND the wallet has
 * >100 cached rows, SKIP the delete and log unseen_delete_suspiciously_large — a
 * latent scan bug must not be able to wipe a whale's collection in one tick. The
 * 14-day prune remains the backstop for a genuine full sell-off.
 */
export async function deleteUnseenWmcRows(args: {
  wallet: string
  collectionUuid: string
  observedIds: Set<string>
  pipelineName: string
  /**
   * The cached id set the caller ALREADY read for its skip-cached filter. Pass it
   * whenever you have one: without it this re-runs the same keyset-paged walk,
   * which on a 154k-row whale is a second full index scan per pass for no new
   * information. A pre-upsert snapshot is fine — and marginally safer — because
   * anything this pass just wrote is by definition in observedIds.
   */
  cachedIds?: Iterable<string>
}): Promise<UnseenDeleteOutcome> {
  const { wallet, collectionUuid, observedIds, pipelineName, cachedIds } = args
  if (observedIds.size === 0) return { deleted: 0, skippedReason: "empty_observed" }

  const cached = cachedIds ? new Set(cachedIds) : await loadCachedMomentIds(wallet, collectionUuid)
  const toDelete: string[] = []
  for (const id of cached) if (!observedIds.has(id)) toDelete.push(id)
  if (toDelete.length === 0) return { deleted: 0 }

  if (cached.size > 100 && toDelete.length > cached.size * 0.9) {
    console.warn(
      `[${pipelineName}] unseen_delete_suspiciously_large wallet=${wallet} ` +
        `cached=${cached.size} would_delete=${toDelete.length} — skipping, leaving it to the 14-day prune`,
    )
    return { deleted: 0, skippedReason: "suspiciously_large" }
  }

  let deleted = 0
  let firstError: string | undefined
  const CHUNK = 200
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK)
    // Always scoped by wallet + collection + an EXPLICIT id list. Never a bare
    // NOT IN / negated filter: a mis-built predicate there deletes the complement.
    // deno-lint-ignore no-explicit-any
    const { error, count } = await (supabaseAdmin as any)
      .from("wallet_moments_cache")
      .delete({ count: "exact" })
      .eq("wallet_address", wallet)
      .eq("collection_id", collectionUuid)
      .in("moment_id", chunk)
    if (error) {
      firstError = String(error.message ?? error)
      console.warn(`[${pipelineName}] unseen-delete chunk failed: ${firstError}`)
      break
    }
    deleted += typeof count === "number" ? count : chunk.length
  }
  if (deleted > 0) {
    console.log(
      `[${pipelineName}] unseen_deleted wallet=${wallet} deleted=${deleted}/${toDelete.length} cached=${cached.size}`,
    )
  }
  return firstError ? { deleted, error: firstError } : { deleted }
}

/**
 * Telemetry shape for the delete-not-seen step. Emitted on EVERY complete-pass
 * log site — including the ones that deliberately SKIP the delete — so an
 * observer keying on `unseen_deleted` never gets NULL from a pipeline that ran,
 * and so a skip says WHY rather than reading as "nothing had left the wallet".
 */
export function unseenDeleteExtra(outcome: UnseenDeleteOutcome): Record<string, unknown> {
  return {
    unseen_deleted: outcome.deleted,
    ...(outcome.skippedReason ? { unseen_delete_skipped: outcome.skippedReason } : {}),
    ...(outcome.error ? { unseen_delete_error: outcome.error.slice(0, 200) } : {}),
  }
}
