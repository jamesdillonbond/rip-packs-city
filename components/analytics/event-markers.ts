// Vertical reference markers placed on every time-series chart so platform
// events line up across views. Note: V1 data only goes back to ~Dec 28 2025
// so the Sept 2024 marker won't be visible until the V2 backfill arrives.

export interface EventMarker {
  date: string // YYYY-MM-DD
  label: string
}

export const PLATFORM_EVENTS: EventMarker[] = [
  { date: "2024-09-04", label: "USDCf launch" },
  { date: "2025-12-28", label: "Flow exploit pause" },
  { date: "2026-01-30", label: "Marketplace reopened" },
]
