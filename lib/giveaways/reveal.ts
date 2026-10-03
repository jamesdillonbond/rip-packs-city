// lib/giveaways/reveal.ts
//
// The pack reveal on the public claim page (Trevor, 2026-10-03: "Would we ever
// be able to do an actual pack?" → "Do it all"). A claimer sees a sealed pack
// and opens it one card at a time, the most valuable card LAST, the way a
// Top Shot pack rips. Pure helpers, kept in lib/ so the coverage gate measures
// them.

export interface RevealMoment {
  moment_id: string
  fmv_usd: number | null
}

/**
 * Order the cards for opening: lowest value first, the chase card last. An
 * unpriced card goes first (sealing refuses unpriced moments, so this is a
 * guard, not a case); ties break on moment id so the order is stable.
 */
export function revealOrder<T extends RevealMoment>(moments: readonly T[]): T[] {
  return moments.slice().sort((a, b) => {
    const av = a.fmv_usd ?? -Infinity
    const bv = b.fmv_usd ?? -Infinity
    if (av !== bv) return av - bv
    return a.moment_id.localeCompare(b.moment_id)
  })
}

/**
 * The card that earns the "chase" label: the single most valuable card, only
 * when it is worth MORE than every other card (a pack of equal commons has no
 * chase, and saying it did would be a false claim).
 */
export function chaseMomentId(moments: readonly RevealMoment[]): string | null {
  const priced = moments.filter((m) => m.fmv_usd != null && Number.isFinite(m.fmv_usd))
  if (priced.length < 2) return null
  const ordered = revealOrder(priced)
  const top = ordered[ordered.length - 1]
  const next = ordered[ordered.length - 2]
  return (top.fmv_usd as number) > (next.fmv_usd as number) ? top.moment_id : null
}

/** A Top Shot moment's art by its Flow id; null for anything not a numeric id. */
export function topShotMomentImage(momentId: string, width = 480): string | null {
  if (!/^\d+$/.test(momentId)) return null
  return `https://assets.nbatopshot.com/media/${momentId}/image?width=${Math.round(width)}`
}

/** The per-browser "already opened" flag for one claimer's pack. */
export function openedKey(slug: string, packNo: number): string {
  return `rpc_giveaway_opened:${slug}:${packNo}`
}
