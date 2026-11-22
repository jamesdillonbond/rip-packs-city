/**
 * Top Shot sales clearing against an ASK_ONLY price — as a sentinel arm (2026-11-22).
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * On the 11-11 Series 9 / Rookie Debut launch, 37.6 % of Top Shot sales cleared while the
 * LIVE price was ASK_ONLY, at a median 2.16× the sale price; within ±25 % at sale fell from
 * ~79 % to 47.8 %. A hot new edition went ~20 h between snapshots under 37 sales. Nothing
 * alarmed — `fmv_accuracy_weekly` stored the failure 12 days later, by design. Drop week is
 * when collectors look hardest (docs/strategy/strategy-2026-11-22.md, Move 1.1).
 *
 * ── WHAT IT FLAGS ───────────────────────────────────────────────────────────
 * From `check_topshot_ask_only_at_sale(6)`: warn when ≥ 100 sales were priced in the window,
 * ≥ 10 % of them sold against ASK_ONLY, and those sold at a median published/sale ratio
 * ≥ 1.5. Calibrated on 16 days of 6 h windows: the four 11-11/11-12 drop windows read
 * 22.6–58.8 % at ratio 1.93–2.43; every other window ≤ 4.7 %. Fewer than 100 sales is too
 * thin to call and reads ok with the count stated.
 *
 * ── WHY IT WARNS ────────────────────────────────────────────────────────────
 * The response is a human one: check the fmv-recalc hot lane (`hot_lane_editions`,
 * `hot_lane_error`) is keeping up with the drop. An unreadable payload is UNMEASURED,
 * never clean.
 */

export type AskOnlyAtSalePayload = {
  hours?: number | string | null
  sales_priced?: number | string | null
  ask_only_sales?: number | string | null
  ask_only_pct?: number | string | null
  ask_only_median_ratio?: number | string | null
  within_25_pct?: number | string | null
}

export type AskOnlyAtSaleVerdict = { status: "ok" | "warn"; detail: string; value?: number }

export const ASK_ONLY_MIN_SALES = 100
export const ASK_ONLY_WARN_PCT = 10
export const ASK_ONLY_WARN_RATIO = 1.5

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN
  return Number.isFinite(n) ? n : null
}

export function summariseTopShotAskOnlyAtSale(payload: unknown): AskOnlyAtSaleVerdict {
  const p = (payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null) as AskOnlyAtSalePayload | null
  const sales = num(p?.sales_priced)
  const askPct = num(p?.ask_only_pct)
  if (!p || sales == null || (sales > 0 && askPct == null)) {
    return {
      status: "warn",
      detail:
        "UNMEASURED — check_topshot_ask_only_at_sale returned no readable result, so drop-day pricing " +
        "was not evaluated. This is an unreadable result, not a clean window.",
    }
  }
  const hours = num(p.hours) ?? 6
  const askN = num(p.ask_only_sales) ?? 0
  const ratio = num(p.ask_only_median_ratio)
  const w25 = num(p.within_25_pct)
  const base = `${hours}h: ${sales} Top Shot sales priced, ${askN} (${askPct ?? 0} %) against ASK_ONLY` +
    (ratio != null ? ` at a median ${ratio}× the sale` : "") +
    (w25 != null ? `; ${w25} % within ±25 % at sale` : "")
  if (sales < ASK_ONLY_MIN_SALES) {
    return { status: "ok", detail: `${base}. Under ${ASK_ONLY_MIN_SALES} sales — too thin to call.`, value: askPct ?? 0 }
  }
  if ((askPct ?? 0) >= ASK_ONLY_WARN_PCT && ratio != null && ratio >= ASK_ONLY_WARN_RATIO) {
    return {
      status: "warn",
      detail:
        `${base}. Sales are clearing well below the published ASK_ONLY price — the drop-day shape of 11-11 ` +
        `(37.6 % at 2.16×). Check fmv-recalc's hot lane (hot_lane_editions / hot_lane_error) is repricing new editions.`,
      value: askPct ?? 0,
    }
  }
  return { status: "ok", detail: `${base}.`, value: askPct ?? 0 }
}
