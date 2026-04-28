// Time-window helpers for the analytics endpoints (loans + sales).
//
// Was lib/analytics/loans-window.ts — renamed because the Sales RPCs use
// the same window vocabulary, and there's no value in duplicating the
// shared parser. The aliases (parseWindow, windowRange, parseCollections,
// LoanWindow) keep their old names so existing call sites stay valid.
//
// All RPCs take p_start_at and p_end_at as timestamptz (or NULL for
// lifetime). We accept both lowercase shorthand ("l7", "y2026") and the
// legacy uppercase forms ("L7", "2026") so existing query strings keep
// working.

export type LoanWindow =
  | "l7"
  | "l30"
  | "l90"
  | "ytd"
  | "y2026"
  | "y2025"
  | "all"

// Generic alias — Sales code reads this name; Loans still uses LoanWindow.
export type AnalyticsWindow = LoanWindow

export const ALLOWED_WINDOWS: readonly LoanWindow[] = [
  "l7",
  "l30",
  "l90",
  "ytd",
  "y2026",
  "y2025",
  "all",
] as const

const ALIASES: Record<string, LoanWindow> = {
  l7: "l7",
  l30: "l30",
  l90: "l90",
  ytd: "ytd",
  y2026: "y2026",
  y2025: "y2025",
  all: "all",
  "2026": "y2026",
  "2025": "y2025",
}

export function parseWindow(raw: string | null | undefined): LoanWindow {
  if (!raw) return "all"
  const lower = raw.toLowerCase()
  return ALIASES[lower] ?? "all"
}

export interface WindowRange {
  startISO: string | null
  endISO: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

function iso(d: Date): string {
  return d.toISOString()
}

export function windowRange(window: LoanWindow, now: Date = new Date()): WindowRange {
  if (window === "all") {
    return { startISO: null, endISO: null }
  }
  if (window === "y2025") {
    return {
      startISO: "2025-01-01T00:00:00.000Z",
      endISO: "2026-01-01T00:00:00.000Z",
    }
  }
  if (window === "y2026") {
    return {
      startISO: "2026-01-01T00:00:00.000Z",
      endISO: "2027-01-01T00:00:00.000Z",
    }
  }
  if (window === "ytd") {
    const year = now.getUTCFullYear()
    const start = new Date(Date.UTC(year, 0, 1))
    return { startISO: iso(start), endISO: iso(now) }
  }
  const days = window === "l7" ? 7 : window === "l30" ? 30 : 90
  const start = new Date(now.getTime() - days * DAY_MS)
  return { startISO: iso(start), endISO: iso(now) }
}

export function parseCollections(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return list.length > 0 ? list : null
}
