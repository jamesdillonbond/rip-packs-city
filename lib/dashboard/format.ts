// Shared pure formatters for the /dashboard sub-pages (history + packs — two
// client monoliths neither coverage gate measures that carried BYTE-IDENTICAL
// copies of fmtUsd / relativeTime). Consolidated here + unit-tested; both pages
// import these. Bodies are byte-identical to the originals.

/** $ — "$0" for zero, whole dollars at/above $1,000, 2 decimals below,
 * em-dash for null/non-finite. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  if (v === 0) return "$0"
  if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString("en-US")
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** "just now" / Nm / Nh / Nd / Nmo / Ny ago; em-dash for empty/unparseable. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "—"
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return "—"
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m ago"
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + "h ago"
  const days = Math.floor(hrs / 24)
  if (days < 30) return days + "d ago"
  const mos = Math.floor(days / 30)
  if (mos < 12) return mos + "mo ago"
  return Math.floor(mos / 12) + "y ago"
}

/** Short address "0x1234…cdef"; empty string for null (the history-page variant). */
export function truncAddr(a: string | null): string {
  if (!a) return ""
  if (a.length <= 12) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}
