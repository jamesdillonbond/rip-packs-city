// Time-window helpers for the loans analytics endpoints.

export type LoanWindow =
  | "L7"
  | "L30"
  | "L90"
  | "YTD"
  | "2026"
  | "2025"
  | "ALL"

export const ALLOWED_WINDOWS: readonly LoanWindow[] = [
  "L7",
  "L30",
  "L90",
  "YTD",
  "2026",
  "2025",
  "ALL",
] as const

export function parseWindow(raw: string | null | undefined): LoanWindow {
  if (!raw) return "ALL"
  const upper = raw.toUpperCase()
  if ((ALLOWED_WINDOWS as readonly string[]).includes(upper)) return upper as LoanWindow
  return "ALL"
}

export interface WindowRange {
  startISO: string | null
  endISO: string | null
  // The prior window of equal length, used for delta calculation.
  prevStartISO: string | null
  prevEndISO: string | null
}

const DAY_MS = 24 * 60 * 60 * 1000

function iso(d: Date): string {
  return d.toISOString()
}

export function windowRange(window: LoanWindow, now: Date = new Date()): WindowRange {
  const end = new Date(now)
  if (window === "ALL") {
    return { startISO: null, endISO: null, prevStartISO: null, prevEndISO: null }
  }
  if (window === "2025") {
    return {
      startISO: "2025-01-01T00:00:00.000Z",
      endISO: "2026-01-01T00:00:00.000Z",
      prevStartISO: "2024-01-01T00:00:00.000Z",
      prevEndISO: "2025-01-01T00:00:00.000Z",
    }
  }
  if (window === "2026") {
    return {
      startISO: "2026-01-01T00:00:00.000Z",
      endISO: "2027-01-01T00:00:00.000Z",
      prevStartISO: "2025-01-01T00:00:00.000Z",
      prevEndISO: "2026-01-01T00:00:00.000Z",
    }
  }
  if (window === "YTD") {
    const year = end.getUTCFullYear()
    const start = new Date(Date.UTC(year, 0, 1))
    const ms = end.getTime() - start.getTime()
    const prevEnd = start
    const prevStart = new Date(start.getTime() - ms)
    return {
      startISO: iso(start),
      endISO: iso(end),
      prevStartISO: iso(prevStart),
      prevEndISO: iso(prevEnd),
    }
  }
  const days = window === "L7" ? 7 : window === "L30" ? 30 : 90
  const start = new Date(end.getTime() - days * DAY_MS)
  const prevEnd = start
  const prevStart = new Date(start.getTime() - days * DAY_MS)
  return {
    startISO: iso(start),
    endISO: iso(end),
    prevStartISO: iso(prevStart),
    prevEndISO: iso(prevEnd),
  }
}

export function parseCollections(raw: string | null | undefined): string[] | null {
  if (!raw) return null
  const list = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  return list.length > 0 ? list : null
}
