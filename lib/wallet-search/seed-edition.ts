// lib/wallet-search/seed-edition.ts
//
// The row → `editions` insert mapping for wallet-search's insert-only seed
// (app/api/wallet-search/route.ts seedEditionsToSupabase).
//
// ⚠ 2026-11-07 review: when a moment's metadata read FAILED, the route builds a
// degraded row ("Unknown (error loading)" / "Unknown Player" / "Unknown Set",
// no tier), and the seed inserted it as a real edition — `85:2918` carried the
// name "Unknown (error loading) — Dynamic Duos" from 05-13 to 11-07 — and
// `resolve_canonical_player` CREATED a player named "Unknown (error loading)"
// (09-25). A missing tier became COMMON, a fabricated value every tier guard
// downstream reads as measured. Now: a degraded row seeds nothing (the next
// clean search, or the catalog lanes, make the edition exist), and an
// unrecognised tier is NULL, never COMMON.

export const PLACEHOLDER_PLAYER_NAMES: ReadonlySet<string> = new Set(["Unknown (error loading)", "Unknown Player"])
export const PLACEHOLDER_SET_NAME = "Unknown Set"

export type SeedSourceRow = {
  editionKey?: string | null
  playerName?: string | null
  setName?: string | null
  tier?: string | null
}

/** The enum value for a wallet row's tier string, or null when it names none. */
export function seedTier(tier: string | null | undefined): string | null {
  const t = (tier ?? "").toUpperCase()
  if (!t) return null
  if (t.includes("LEGENDARY")) return "LEGENDARY"
  if (t.includes("RARE")) return "RARE"
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("UNCOMMON")) return "UNCOMMON"
  if (t.includes("FANDOM")) return "FANDOM"
  if (t.includes("COMMON")) return "COMMON"
  return null
}

/** Whether this row's metadata was actually read (false = a degraded placeholder row). */
export function isSeedableRow(row: SeedSourceRow): row is SeedSourceRow & { editionKey: string; playerName: string; setName: string } {
  if (!row.editionKey) return false
  const player = (row.playerName ?? "").trim()
  const set = (row.setName ?? "").trim()
  if (!player || PLACEHOLDER_PLAYER_NAMES.has(player)) return false
  if (!set || set === PLACEHOLDER_SET_NAME) return false
  return true
}
