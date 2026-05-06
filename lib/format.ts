// Shared currency / count formatters.
//
// Semantics:
//   null / undefined / NaN  → em-dash ("—")  — data is genuinely missing
//   0                       → "$0"            — real, computed zero
//   positive / negative     → "$X,XXX.XX" / "-$X,XXX.XX" with thousands

export function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  if (value === 0) return "$0"
  const sign = value < 0 ? "-" : ""
  const abs = Math.abs(Number(value)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return sign + "$" + abs
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  return Number(value).toLocaleString("en-US")
}
