// lib/panini/subjects.ts
//
// Pure (client-safe) Panini subject rules. Kept out of lib/panini/edition-market.ts,
// which imports the service-role client and must never reach a client bundle.

/**
 * Does this Panini card have a PLAYER subject with a player page? The bridge
 * (sync_panini_editions_to_shared) links no `players` row for dual-player cards
 * ("Lionel Messi | Angel Di Maria") or for the Team Badges / World Cup Posters
 * sets, whose subject is a nation or a poster — 208 editions measured
 * 2026-09-27. A player link built for them is a 404. Same rule as the bridge.
 */
export function paniniSubjectIsPlayer(playerName: string | null | undefined, setName: string | null | undefined): boolean {
  if (!playerName || !playerName.trim()) return false
  if (playerName.includes("|")) return false
  const s = (setName ?? "").trim().toLowerCase()
  return !(s.startsWith("team badges") || s.startsWith("world cup posters"))
}
