// Pure formatters for the admin Flowty-errors triage console
// (app/admin/flowty-errors/ErrorTriageClient.tsx — a ~1,110-line client with ZERO
// lib imports, so none of these were measured). Bodies are byte-identical to the
// originals; the console imports them. NOTE: these are this page's own variants
// (with NaN guards / seconds precision) — the /admin/feedback page has subtly
// DIFFERENT copies (no NaN guard, minute precision) that are deliberately left
// untouched so behavior doesn't shift.

export function fmtInt(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "—"
  return Math.round(n).toLocaleString("en-US")
}

export function timeAgo(iso: string | null): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (isNaN(t)) return "—"
  const ms = Date.now() - t
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

export function fmtIso(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (isNaN(d.getTime())) return "—"
  return d.toISOString().replace("T", " ").slice(0, 19) + " UTC"
}

export function truncSig(sig: string | null, len = 28): string {
  if (!sig) return "—"
  if (sig.length <= len) return sig
  return `${sig.slice(0, len)}…`
}

export function truncAddr(addr: string | null): string {
  if (!addr) return "—"
  if (addr.length <= 14) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

export function truncMid(s: string | null, len = 80): string {
  if (!s) return "—"
  if (s.length <= len) return s
  return `${s.slice(0, len)}…`
}
