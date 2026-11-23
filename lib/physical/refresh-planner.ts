/**
 * Which cards to re-price this run, under the feed's monthly sold-sale quota
 * (prototype, NOT wired).
 *
 * HCI counts ONE sold-sale lookup per /sales call, whatever it returns. Lite
 * allows 5,000/month; the setup month 500. The planner spends a daily slice of
 * what is left so the month never runs dry early, and spends it on cards
 * people actually hold, oldest price first.
 *
 * A card fetched once covers every grade (one /sales call returns all grades),
 * so the unit of work is the CARD, not the holding.
 */

export type RefreshCandidate = {
  cardId: string
  holders: number // distinct users holding it
  lastComputedAt: string | null // newest physical_value_cache row for the card
}

export type QuotaState = {
  monthlyAllowance: number
  usedThisMonth: number
  daysLeftInMonth: number // including today, >= 1
}

export type PlanOptions = {
  asOf: string
  minAgeHours?: number // don't re-price a card fresher than this; default 24
  reserveFraction?: number // keep for on-demand lookups (a user adding a card); default 0.2
}

export function dailyBudget(q: QuotaState, reserveFraction = 0.2): number {
  const left = Math.max(0, q.monthlyAllowance - q.usedThisMonth)
  const spendable = Math.floor(left * (1 - reserveFraction))
  return Math.floor(spendable / Math.max(1, q.daysLeftInMonth))
}

export function planRefresh(cands: RefreshCandidate[], q: QuotaState, opts: PlanOptions): string[] {
  const budget = dailyBudget(q, opts.reserveFraction ?? 0.2)
  if (budget <= 0) return []
  const now = Date.parse(opts.asOf)
  const minAgeMs = (opts.minAgeHours ?? 24) * 3_600_000
  const age = (c: RefreshCandidate) => (c.lastComputedAt ? now - Date.parse(c.lastComputedAt) : Number.POSITIVE_INFINITY)

  return cands
    .filter((c) => c.holders > 0 && age(c) >= minAgeMs)
    .sort((a, b) => {
      // Never-priced first, then most-held, then oldest.
      const an = a.lastComputedAt == null ? 0 : 1
      const bn = b.lastComputedAt == null ? 0 : 1
      if (an !== bn) return an - bn
      if (b.holders !== a.holders) return b.holders - a.holders
      return age(b) - age(a)
    })
    .slice(0, budget)
    .map((c) => c.cardId)
}
