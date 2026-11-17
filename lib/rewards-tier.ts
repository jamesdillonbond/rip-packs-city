// Pure reward-tier progression helpers for the rewards page
// (app/rewards/page.tsx, outside the coverage include). The tier ladder and the
// progress math decide what a member sees for their status: which tier they're
// in, the % bar to the next tier, and the points remaining — a bug here
// mislabels someone's standing or renders a >100% / negative bar.

export const TIERS = [
  { name: "Rookie", min: 0 },
  { name: "Role Player", min: 500 },
  { name: "Starter", min: 2500 },
  { name: "All-Star", min: 10000 },
  { name: "Franchise", min: 30000 },
] as const

export type Tier = (typeof TIERS)[number]

export interface TierProgress {
  current: Tier
  next: Tier | null
  /** % into the current tier toward the next (0–100); 100 at the top tier. */
  pct: number
  /** Points remaining to reach `next`; 0 at the top tier. */
  toNext: number
}

/** Resolve a status-points value to its tier, the next tier, and the % / points to it. */
export function tierProgress(status: number): TierProgress {
  let current: Tier = TIERS[0]
  let next: Tier | null = null
  for (let i = 0; i < TIERS.length; i++) {
    if (status >= TIERS[i].min) {
      current = TIERS[i]
      next = TIERS[i + 1] ?? null
    }
  }
  if (!next) return { current, next: null, pct: 100, toNext: 0 }
  const span = next.min - current.min
  const into = status - current.min
  const pct = Math.max(0, Math.min(100, Math.round((into / span) * 100)))
  return { current, next, pct, toNext: next.min - status }
}

/** Name of the highest tier whose threshold `min` clears. */
export function tierNameForStatus(min: number): string {
  let name: string = TIERS[0].name
  for (const t of TIERS) if (min >= t.min) name = t.name
  return name
}
