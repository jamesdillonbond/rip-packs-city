// lib/pinnacle/ask-history.ts
//
// The pin page's "lowest ask" line (2026-11-23). Source: pinnacle_floor_ask_history,
// a CHANGE-ONLY log of pinnacle_catalog.floor_ask written by trigger since
// 2026-10-19 (20261019152952). The value in force at T is the latest row with
// observed_at <= T; a NULL floor_ask means the sweep saw NO live ask.
//
// Three states per point, never two (CLAUDE.md "Honesty"):
//   ask_usd = number     -> the lowest live ask RPC saw at that time
//   ask_usd = null       -> RPC's sweep saw no live ask (a real fact; the line breaks)
//   ask_usd = undefined  -> before ask tracking began for this pin (not a fact; no line)
// FMV history (pinnacle_fmv_history) is also written only on change, so both
// series are carried forward to every timestamp of the union.

export interface PinnacleAskPoint {
  observed_at: string
  floor_ask: number | null
}

export interface MergedPricePoint {
  t: string
  fmv_usd: number | null | undefined
  ask_usd: number | null | undefined
  fmv_sales_count_30d: number | null | undefined
}

/** First day ask tracking began site-wide (the table's seed run). */
export const ASK_HISTORY_SINCE_ISO = "2026-10-19T13:45:00.000Z"

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/**
 * Merge change-only FMV and ask series onto one ascending timeline, carrying each
 * forward. Never extends either series past its own newest row with a wall-clock
 * "now" (a render-time clock read is the React #418 hydration class).
 */
export function mergeFmvAndAsk(
  fmv: { computed_at: string; fmv_usd: number | null; fmv_sales_count_30d?: number | null }[],
  asks: PinnacleAskPoint[] | null,
): MergedPricePoint[] {
  type Ev = { ms: number; iso: string; kind: "fmv" | "ask"; v: number | null; sales?: number | null }
  const evs: Ev[] = []
  for (const p of fmv) {
    const ms = Date.parse(p.computed_at)
    if (Number.isNaN(ms)) continue
    evs.push({ ms, iso: p.computed_at, kind: "fmv", v: num(p.fmv_usd), sales: p.fmv_sales_count_30d ?? null })
  }
  for (const a of asks ?? []) {
    const ms = Date.parse(a.observed_at)
    if (Number.isNaN(ms)) continue
    evs.push({ ms, iso: a.observed_at, kind: "ask", v: num(a.floor_ask) })
  }
  // Stable for equal instants: FMV first, then ask, so both land on one point.
  evs.sort((a, b) => a.ms - b.ms || (a.kind === b.kind ? 0 : a.kind === "fmv" ? -1 : 1))

  const out: MergedPricePoint[] = []
  let fmvNow: number | null | undefined = undefined
  let salesNow: number | null | undefined = undefined
  let askNow: number | null | undefined = undefined
  for (const e of evs) {
    if (e.kind === "fmv") {
      // A null FMV row keeps the last known FMV out of the line (gap), same as before.
      fmvNow = e.v
      salesNow = e.sales
    } else {
      askNow = e.v
    }
    const last = out[out.length - 1]
    if (last && Date.parse(last.t) === e.ms) {
      last.fmv_usd = fmvNow
      last.ask_usd = askNow
      last.fmv_sales_count_30d = salesNow
    } else {
      out.push({ t: e.iso, fmv_usd: fmvNow, ask_usd: askNow, fmv_sales_count_30d: salesNow })
    }
  }
  return out
}

/** Asks newest-first from the read, returned ascending; null stays null (read failed). */
export function asksAscending(rows: PinnacleAskPoint[] | null): PinnacleAskPoint[] | null {
  if (rows === null) return null
  return [...rows].sort((a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at))
}
