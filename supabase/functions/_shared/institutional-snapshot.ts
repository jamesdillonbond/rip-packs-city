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
