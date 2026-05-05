// lib/fmv-phantom-guard.ts
//
// Source-side mirror of the fmv_snapshots_block_phantoms_trg trigger.
// Phantom condition: fmv_usd > 10000 AND NOT (confidence === 'HIGH' AND sales_count_30d >= 3).
// When the condition is true on a row about to be written into fmv_snapshots,
// we null fmv_usd, wap_usd, and floor_price_usd before the INSERT so the
// trigger no longer needs to intercept the row. The trigger stays in place as
// a defensive backstop for any future write path that forgets this guard.
//
// Test cases (asserted in fmv-phantom-guard.test.ts logic comments):
//   1. { fmv_usd: 50,     confidence: 'HIGH', sales_count_30d: 5 } → unchanged
//   2. { fmv_usd: 500000, confidence: 'LOW',  sales_count_30d: 0 } → fmv/wap/floor nulled
//   3. { fmv_usd: 15000,  confidence: 'HIGH', sales_count_30d: 3 } → unchanged (legitimate rare-card)
//   4. { fmv_usd: 15000,  confidence: 'HIGH', sales_count_30d: 2 } → fmv/wap/floor nulled
//   5. { fmv_usd: null,   confidence: 'LOW',  sales_count_30d: 0 } → unchanged (already null)

export function isFmvPhantom(row: {
  fmv_usd: number | null | undefined
  confidence: string | null | undefined
  sales_count_30d: number | null | undefined
}): boolean {
  const fmv = typeof row.fmv_usd === "number" ? row.fmv_usd : null
  if (fmv === null || !(fmv > 10000)) return false
  const isHighWithSales =
    row.confidence === "HIGH" && (row.sales_count_30d ?? 0) >= 3
  return !isHighWithSales
}

export function applyPhantomGuard<T extends Record<string, unknown>>(row: T): T {
  const fmv = typeof row.fmv_usd === "number" ? row.fmv_usd : null
  if (fmv === null || !(fmv > 10000)) return row
  const conf = typeof row.confidence === "string" ? row.confidence : null
  const sales30 =
    typeof row.sales_count_30d === "number" ? row.sales_count_30d : 0
  if (conf === "HIGH" && sales30 >= 3) return row

  console.warn(
    `[FMV-PHANTOM-GUARD] Nulled phantom snapshot — ` +
      `edition_id=${String(row.edition_id ?? "unknown")} ` +
      `fmv_usd=${fmv} ` +
      `wap_usd=${row.wap_usd ?? "null"} ` +
      `floor_price_usd=${row.floor_price_usd ?? "null"} ` +
      `confidence=${conf ?? "null"} ` +
      `sales_count_30d=${sales30}`,
  )

  return {
    ...row,
    fmv_usd: null,
    wap_usd: null,
    floor_price_usd: null,
  } as T
}
