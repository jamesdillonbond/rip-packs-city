// Pure formatters + data-shapers for the admin Flowty-analytics dashboard
// (app/admin/flowty-analytics/page.tsx — a ~1,120-line client with ZERO lib
// imports, so none of these were measured). Bodies are byte-identical to the
// originals; the page imports them.

/** $ with whole-dollar grouping at/above $1,000, 2 decimals below. */
export function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—"
  if (Math.abs(n) >= 1000) {
    return `$${Math.round(n).toLocaleString("en-US")}`
  }
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}

/** Percent. Accepts both 0.12 and 12 forms — values with |n| <= 1 are treated
 * as decimals and scaled ×100. */
export function fmtPct(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—"
  const pct = Math.abs(n) <= 1 ? n * 100 : n
  return `${pct.toFixed(2)}%`
}

export function truncAddr(addr: string | null | undefined): string {
  if (!addr) return "—"
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

/** Pivot long-form timeseries ({bucket, collection, ...}) into wide form for
 * recharts ([{bucket, [collection]: value, ...}]), summing per (bucket,
 * collection) and 0-filling every collection so recharts doesn't break a line. */
export function pivot<T extends { bucket: string; collection: string }>(
  rows: T[],
  metric: keyof T,
  collections: readonly string[],
): Array<Record<string, string | number>> {
  const map = new Map<string, Record<string, string | number>>()
  for (const r of rows) {
    if (!collections.includes(r.collection)) continue
    const existing = map.get(r.bucket) ?? { bucket: r.bucket }
    const v = r[metric]
    if (typeof v === "number") existing[r.collection] = ((existing[r.collection] as number) ?? 0) + v
    map.set(r.bucket, existing)
  }
  const out = Array.from(map.values()).sort((a, b) => String(a.bucket).localeCompare(String(b.bucket)))
  for (const row of out) {
    for (const c of collections) {
      if (!(c in row)) row[c] = 0
    }
  }
  return out
}

/** Minimal SalesPoint shape pickSalesActor reads. */
export interface SalesActorPoint {
  distinctBuyers?: number | null
  activeBuyers?: number | null
  distinctSellers?: number | null
  activeSellers?: number | null
}

/** Pull either distinct* (daily) or active* (non-daily) buyer/seller count. */
export function pickSalesActor(p: SalesActorPoint, kind: "buyers" | "sellers"): number {
  if (kind === "buyers") return p.distinctBuyers ?? p.activeBuyers ?? 0
  return p.distinctSellers ?? p.activeSellers ?? 0
}
