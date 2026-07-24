// Shared pure formatters for the collection analytics page
// (app/(collections)/[collection]/analytics/page.tsx) and its extracted card
// components. Behavior-identical verbatim move — no logic changes.

export function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  const d = Math.floor(diff / 86400000)
  if (d < 1) {
    const h = Math.floor(diff / 3600000)
    if (h < 1) return "just now"
    return `${h}h ago`
  }
  if (d < 30) return `${d}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

export function fmtUsd(n: number): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

export function shortAddr(addr: string): string {
  if (!addr) return "—"
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// Percentage change from `prev` to `curr`, rounded to one decimal. Null-safe and
// zero/negative-safe: a nullish/non-finite input, or a non-positive baseline (a
// %-change off 0 is undefined and would render a misleading ∞/huge number),
// yields null so the caller shows "—" instead of a fabricated delta.
// (Verbatim move out of components/analytics/PulseDashboard.tsx.)
export function deltaPct(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev)) return null
  if (prev <= 0) return null
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

// Earliest / latest of a set of ISO-8601 timestamps, ignoring nullish entries.
// ISO-8601 sorts correctly lexicographically, so a plain string sort is safe.
// Returns null when no valid timestamp is present.
// (Verbatim move out of components/analytics/WalletProfile.tsx.)
export function pickEarliest(...isos: Array<string | null | undefined>): string | null {
  const valid = isos.filter((x): x is string => Boolean(x)).sort()
  return valid[0] ?? null
}

export function pickLatest(...isos: Array<string | null | undefined>): string | null {
  const valid = isos.filter((x): x is string => Boolean(x)).sort()
  return valid[valid.length - 1] ?? null
}
