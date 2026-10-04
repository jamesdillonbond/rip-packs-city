/**
 * The "who" half of a Top Shot edition name: the player, or — for a TEAM Moment, which has no
 * player — the team (R8, 2026-10-04). Dapper's on-chain "<invalid Value>" sentinel is never a
 * subject. Returns null when neither is known, so the caller falls back to the set name alone.
 */
export function teamMomentSubject(
  playerName: string | null | undefined,
  teamName: string | null | undefined,
): string | null {
  const clean = (v: string | null | undefined) => {
    const t = (v ?? "").trim()
    return t && t !== "<invalid Value>" ? t : null
  }
  return clean(playerName) ?? clean(teamName)
}
