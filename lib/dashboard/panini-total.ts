// lib/dashboard/panini-total.ts
//
// Panini in the single Portfolio FMV (Trevor, 2026-11-25: "Yes it should be"). A Panini owner is
// a USERNAME, so its cards never reach get_wallet_collection_stats (#64); the dashboard sums the
// linked usernames' newest recorded collection value (panini_portfolio_daily, carried on
// /api/profile/collector-identities as summary.profile.value) and adds it to Total Assets,
// Portfolio FMV and Collections. Pure — unit-tested in __tests__/dashboard-panini-total.test.ts.
//
// HONESTY: not read yet (undefined) and failed (null) both add nothing; a failure is said under
// the figure. A username with no recorded day adds its profile-read card count (if any) and $0.

export interface PaniniValueLike {
  summary?: {
    profile?: {
      cards_held?: number | null
      value?: { cards: number; fmv_usd: number | null } | null
    } | null
  } | null
}

export interface PaniniTotal {
  cards: number
  fmvUsd: number
  usernames: number
}

export function sumPaniniIdentities(ids: PaniniValueLike[] | null | undefined): PaniniTotal {
  let cards = 0
  let fmv = 0
  for (const i of ids ?? []) {
    const p = i.summary?.profile
    const v = p?.value ?? null
    const c = v ? Number(v.cards) : Number(p?.cards_held ?? 0)
    if (Number.isFinite(c)) cards += c
    const f = v?.fmv_usd == null ? 0 : Number(v.fmv_usd)
    if (Number.isFinite(f)) fmv += f
  }
  return { cards, fmvUsd: Math.round(fmv * 100) / 100, usernames: (ids ?? []).length }
}

/** The note under the headline figures when the Panini read failed. */
export function paniniCaption(ids: unknown[] | null | undefined): string | null {
  return ids === null ? "Panini cards couldn't load — not included" : null
}
