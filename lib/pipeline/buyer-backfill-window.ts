// lib/pipeline/buyer-backfill-window.ts
//
// The forward window and run verdict for /api/admin/backfill-allday-buyers
// (All Day + Golazos buyer/seller re-resolve from tx events).
//
// WHY THE FLOOR IS THE SPORK, NOT A YEAR (2026-10-17). The route decodes each
// sale's transaction through current-spork REST (rest-mainnet.onflow.org),
// which only knows transactions from mainnet27's root on (height 130,290,658,
// 2025-10-22). The window used to start 2025-01-01 on the belief that "2025+"
// was current-spork. It is not: from 10-15 the cursor crossed below 10-22 and
// every run failed to decode 480 of 480 rows, wrote 0, and still logged
// ok=true, walking ~10 months of rows that can never resolve (known-issues
// #192). The historical access nodes that could decode them (mainnet24-26)
// went dark 10-08/09 (#181).
export const CURRENT_SPORK_START_ISO = "2025-10-22T00:00:00Z"

export type BuyerBackfillCounts = {
  found: number
  decodeFailed: number
  updateFailed: number
}

// A run is NOT ok when it wrote nothing it read: every row in a non-empty
// batch failed to decode (a decode wall — the shape #192 hid behind ok=true),
// or any resolved row's UPDATE failed (a swallowed write). Rows that decode to
// no buyer one at a time are normal and stay counted in decode_failed.
export function buyerBackfillVerdict(c: BuyerBackfillCounts): { ok: boolean; error: string | null } {
  if (c.updateFailed > 0) {
    return { ok: false, error: `${c.updateFailed} sales update(s) failed` }
  }
  if (c.found > 0 && c.decodeFailed >= c.found) {
    return { ok: false, error: `decode wall: all ${c.found} rows failed to decode` }
  }
  return { ok: true, error: null }
}
