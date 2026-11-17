// lib/trophy/fill-main.ts
//
// "Fill with my top 6" for the MAIN trophy case (2026-11-16). Members who pinned
// on their first day came back far more often than those who did not (since
// 09-01: 12 of 12 challenge entrants, 3 of 5 main-case pinners, 5 of 16 who saved
// a wallet and pinned nothing). The main case's only path was "+ Pick a moment",
// one slot at a time through the picker — six trips. Challenge entries already had
// one-tap "Fill my case" (lib/trophy/fill-case.ts); this is the main-case version.
//
// Candidates are exactly the rows the trophy picker offers
// (get_user_top_owned_moments: the highest-FMV moments across the member's saved
// wallets), so filling makes no ownership claim the picker does not already make.
//
// Order: highest FMV first (the RPC's order), one moment per edition while there
// are enough distinct editions, never a moment already pinned, only EMPTY slots.

export interface MainFillCandidate {
  moment_id: string
  collection_id: string
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  mint_count: number | null
  fmv_usd: number | string | null
  image_url: string | null
}

export interface MainFillPick extends MainFillCandidate {
  slot: number
}

export function freeMainSlots(pinnedSlots: readonly number[]): number[] {
  const taken = new Set(pinnedSlots)
  return [1, 2, 3, 4, 5, 6].filter((s) => !taken.has(s))
}

export function chooseMainFillPicks(
  candidates: readonly MainFillCandidate[],
  opts: { freeSlots: readonly number[]; pinnedMomentIds: ReadonlySet<string>; pinnedEditions: ReadonlySet<string> },
): MainFillPick[] {
  const need = opts.freeSlots.length
  if (need === 0) return []
  const usable = candidates.filter((c) => c.moment_id && !opts.pinnedMomentIds.has(String(c.moment_id)))
  const chosen: MainFillCandidate[] = []
  const chosenIds = new Set<string>()
  const editions = new Set<string>(opts.pinnedEditions)
  // Pass 1: one per edition, so six copies of one edition never fill the case.
  for (const c of usable) {
    if (chosen.length >= need) break
    if (c.edition_key && editions.has(c.edition_key)) continue
    chosen.push(c)
    chosenIds.add(String(c.moment_id))
    if (c.edition_key) editions.add(c.edition_key)
  }
  // Pass 2: too few distinct editions — top up with the next-highest moments.
  for (const c of usable) {
    if (chosen.length >= need) break
    if (chosenIds.has(String(c.moment_id))) continue
    chosen.push(c)
    chosenIds.add(String(c.moment_id))
  }
  return chosen.map((c, i) => ({ ...c, slot: opts.freeSlots[i] }))
}

export type MainFillProposal = { slot: number; player_name: string | null; set_name: string | null; serial_number: number | null; fmv: number | null }

/** The confirm text for "Fill with my top 6". Pure, so every outcome is pinned. */
export function mainFillConfirmCopy(picks: readonly MainFillProposal[], short: number): string {
  const lines = picks.map((p) => {
    const name = [p.player_name, p.set_name].filter(Boolean).join(" · ") || "Moment"
    const serial = typeof p.serial_number === "number" ? ` #${p.serial_number}` : ""
    const price = typeof p.fmv === "number" ? ` · ~$${p.fmv.toFixed(2)}` : ""
    return `Slot ${p.slot}: ${name}${serial}${price}`
  })
  const tail = short > 0 ? `\n\nThat leaves ${short} slot${short === 1 ? "" : "s"} empty — pick ${short === 1 ? "it" : "them"} by hand any time.` : ""
  return `Pin your top ${picks.length} to your trophy case? You can swap any of them later.\n\n${lines.join("\n")}${tail}`
}
