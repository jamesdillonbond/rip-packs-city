// _shared/institutional-snapshot.ts
//
// Pure cores for snapshot-institutional-wallets, extracted 2026-07-26 so the
// whale-holdings aggregation and the retry classification are unit-testable
// under vitest (the edge fn runs on Deno, outside the CI coverage measure).
//
// The daily snapshot is the baseline that compute_institutional_wallet_diff
// diffs against to detect new whale arrivals. If total_fmv_usd is aggregated
// wrong, every downstream "whale added $X" signal is wrong, silently.

export interface HoldingRow {
  collection_id: string
  moment_id: string | number
  fmv_usd: number | null
}

export interface CollectionSnapshot {
  collection_id: string
  moment_ids: string[]
  moment_count: number
  total_fmv_usd: number
}

// Retry classifier — which Supabase error messages are worth a backoff-retry vs
// a hard fail. Kept verbatim with the edge fn's inline copy (source-drift
// guarded). Over-matching wastes retries; under-matching turns a transient pool
// blip into a failed daily snapshot.
export function isTransientErr(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("connection pool") ||
    m.includes("upstream request") ||
    m.includes("network") ||
    m.includes("temporarily") ||
    m.includes("503") ||
    m.includes("502") ||
    m.includes("504") ||
    m.includes("429")
  )
}

// One snapshot row per collection: grouped moment_ids (sorted, string-coerced),
// their count, and the summed FMV rounded to cents. A null fmv_usd contributes
// 0 (not NaN) — a single NaN would poison the whole wallet's total.
export function aggregateHoldingsByCollection(rows: HoldingRow[]): CollectionSnapshot[] {
  const byCollection = new Map<string, { ids: string[]; total_fmv: number }>()
  for (const r of rows) {
    const bucket = byCollection.get(r.collection_id) ?? { ids: [], total_fmv: 0 }
    bucket.ids.push(String(r.moment_id))
    bucket.total_fmv += r.fmv_usd != null ? Number(r.fmv_usd) : 0
    byCollection.set(r.collection_id, bucket)
  }
  const out: CollectionSnapshot[] = []
  for (const [collection_id, { ids, total_fmv }] of byCollection.entries()) {
    ids.sort()
    out.push({
      collection_id,
      moment_ids: ids,
      moment_count: ids.length,
      total_fmv_usd: Math.round(total_fmv * 100) / 100,
    })
  }
  return out
}

/**
 * 🚨 A SNAPSHOT BUILT FROM AN INCOMPLETE WALK IS NOT THE DAY'S HOLDINGS.
 *
 * `loadAllMomentsForWallet` pages `wallet_moments_cache` and, when a page
 * exhausts its retries, RETURNS THE ROWS IT ALREADY HAS together with an error.
 * The caller used to push that error into `errors[]` and then upsert the partial
 * rows as the day's snapshot anyway — a failed read persisted as a fact, on the
 * one table every downstream diff treats as ground truth.
 *
 * ── MEASURED, 2026-09-13/14 ────────────────────────────────────────────────
 * 0x4d2c9216f1dca098 (Top Shot) snapshots read 52,120 · 52,120 · **1,000** ·
 * 52,120 on 09-10 / 09-12 / 09-13 / 09-14. The 1,000 is 4 pages × PAGE_SIZE,
 * written by the 09-13 12:46Z run that died on `wmc_load_page_4` — and, because
 * the upsert is keyed on (wallet, collection, day), **it overwrote the COMPLETE
 * snapshot the 10:07Z run had written two hours earlier the same day.**
 *
 * The next day's diff then read 52,120 − 1,000 = **~51,120 "arrivals"** and began
 * inserting them into `topshot_insider_buybacks` as `direct_transfer`
 * acquisitions. It only stopped because the statement timeout killed it at
 * ~156–178 s and rolled the transaction back — twice, 09-14 10:07Z and 14:16Z.
 * **Nothing about that is a guard; the timeout is the only reason zero fabricated
 * rows landed.**
 *
 * ⭐ This is the SECOND variant of one defect in this file. The ORDER BY comment
 * above records the first: an unordered offset walk read the right NUMBER of rows
 * and the wrong SET, producing **161,366 fabricated buyback acquisitions** over
 * three months. That fix made the walk correct when it COMPLETES. This one makes
 * an INCOMPLETE walk stop pretending it did.
 *
 * Refusing to write is strictly safer than writing a partial: a MISSING snapshot
 * makes the next day's diff return `baseline_day` and insert nothing, whereas a
 * SHRUNKEN one makes every moment it dropped look like a fresh acquisition.
 */
export function shouldPersistSnapshot(
  load: { err?: string | null; rows: readonly unknown[] },
): { persist: boolean; reason: "complete" | "incomplete_load" | "no_rows" } {
  // ⚠ Order matters: an errored walk that happens to have loaded zero rows is
  // still an INCOMPLETE LOAD, not an empty wallet, and the two must not be
  // reported as the same thing.
  if (load.err) return { persist: false, reason: "incomplete_load" }
  if (load.rows.length === 0) return { persist: false, reason: "no_rows" }
  return { persist: true, reason: "complete" }
}
