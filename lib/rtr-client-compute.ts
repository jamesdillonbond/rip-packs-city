// rtr-client-compute — pure scoring/tier/ROI/formatting logic lifted out of
// components/rtr/RTRClient.tsx so it lands under the vitest coverage `include`
// (lib/**), which does NOT measure components/**. No React/JSX, no browser
// globals — behavior is identical to the inline code it replaced. Any
// current-time dependency takes an injectable `now` param (the component omits
// it, so runtime behavior is unchanged).

// ── Tier progress ─────────────────────────────────────────────────────

export type TierName = "Prospect" | "Starter" | "All-Star" | "All-NBA" | "MVP" | "Legend"

export interface TierThreshold {
  name: TierName
  min: number
  max: number
}

export const TIER_THRESHOLDS: TierThreshold[] = [
  { name: "Prospect", min: 0,       max: 999       },
  { name: "Starter",  min: 1000,    max: 9999      },
  { name: "All-Star", min: 10000,   max: 39999     },
  { name: "All-NBA",  min: 40000,   max: 99999     },
  { name: "MVP",      min: 100000,  max: 199999    },
  { name: "Legend",   min: 200000,  max: Infinity  },
]

// Highest tier whose `min` the points clear; falls back to the lowest tier.
export function tierFor(points: number): TierThreshold {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (points >= TIER_THRESHOLDS[i].min) return TIER_THRESHOLDS[i]
  }
  return TIER_THRESHOLDS[0]
}

export interface TierProgress {
  currentTier: TierThreshold
  nextTier: TierThreshold | null
  lower: number
  upper: number
  progressPct: number
}

// The progress-bar math for the Tier Progress card. Clamped to [0,100];
// the max tier (no next tier) always reads 100%.
export function computeTierProgress(points: number): TierProgress {
  const currentTier = tierFor(points)
  const tierIndex = TIER_THRESHOLDS.findIndex(t => t.name === currentTier.name)
  const nextTier =
    tierIndex >= 0 && tierIndex < TIER_THRESHOLDS.length - 1 ? TIER_THRESHOLDS[tierIndex + 1] : null
  const lower = currentTier.min
  const upper = nextTier ? nextTier.min : currentTier.min
  const span = Math.max(1, upper - lower)
  const progressPct = nextTier ? Math.min(100, Math.max(0, ((points - lower) / span) * 100)) : 100
  return { currentTier, nextTier, lower, upper, progressPct }
}

// ── Time / odds formatters ────────────────────────────────────────────

export function relativeTimeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "never"
  const delta = now - ms
  if (delta < 60_000) return "just now"
  const min = Math.round(delta / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.round(hr / 24)
  return `${days}d ago`
}

export function formatOddsAge(iso: string, now: number = Date.now()): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "unknown"
  const delta = now - ms
  if (delta < 60_000) return "just now"
  const min = Math.round(delta / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  return `${hr}h ago`
}

export function formatAmericanOdds(odds: number): string {
  if (!Number.isFinite(odds) || odds === 0) return "—"
  return odds > 0 ? `+${odds}` : String(odds)
}

export function formatTipoff(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  // Use Intl with no explicit timezone so the user's local TZ wins on
  // hydration. SSR will render UTC briefly; that's acceptable.
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms))
}

// ── Tier Progress save validation ─────────────────────────────────────

export interface RtrInputValidation {
  valid: boolean
  points: number
  balance: number
}

// Both fields must parse to finite, non-negative numbers.
export function validateRtrInputs(pointsInput: string, balanceInput: string): RtrInputValidation {
  const points = Number(pointsInput)
  const balance = Number(balanceInput)
  const valid =
    Number.isFinite(points) && points >= 0 && Number.isFinite(balance) && balance >= 0
  return { valid, points, balance }
}

// ── Tonight's Pick view ───────────────────────────────────────────────

export interface LivePickInput {
  recommendedSide: "home_ml" | "away_ml"
  homeTeam: string
  awayTeam: string
  homeML: number
  awayML: number
  impliedProbability: number
}

export interface LivePickView {
  sideTeam: string
  opposingTeam: string
  sideMl: number
  pct: number
}

export function computeLivePickView(pick: LivePickInput): LivePickView {
  const isHome = pick.recommendedSide === "home_ml"
  return {
    sideTeam: isHome ? pick.homeTeam : pick.awayTeam,
    opposingTeam: isHome ? pick.awayTeam : pick.homeTeam,
    sideMl: isHome ? pick.homeML : pick.awayML,
    pct: Math.round(pick.impliedProbability * 100),
  }
}

// ── Lock ROI sort ─────────────────────────────────────────────────────

export type LockRoiSortKey =
  | "pointsPerDollar"
  | "currentFmvUsd"
  | "estimatedPlayoffPoints"
  | "playerName"
  | "setName"
export type LockRoiSortDir = "asc" | "desc"

export interface LockRoiSortable {
  pointsPerDollar: number
  currentFmvUsd: number
  estimatedPlayoffPoints: number
  playerName: string | null
  setName: string | null
}

// Stable-ish column sort: numeric fields compared numerically, string fields
// via localeCompare (null coerced to ""). Returns a new array; input untouched.
export function sortLockRoiRows<T extends LockRoiSortable>(
  rows: T[],
  sortKey: LockRoiSortKey,
  sortDir: LockRoiSortDir,
): T[] {
  const out = rows.slice()
  out.sort((a, b) => {
    const av = a[sortKey]
    const bv = b[sortKey]
    let cmp = 0
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv
    else cmp = String(av ?? "").localeCompare(String(bv ?? ""))
    return sortDir === "asc" ? cmp : -cmp
  })
  return out
}
