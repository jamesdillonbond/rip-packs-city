// lib/moment-detail/similar-edition-label.ts

/**
 * 2026-09-25: the "Similar editions" tiles are, on Top Shot, this play's OTHER
 * PARALLELS — same player, tier, series and set — so six tiles read identically
 * ("Courtney Lee · RARE · Series 2025-26 · Run It Back: For The Win") with only
 * the price differing. Name the parallel from the printing ladder already on
 * the page (matched on external_id), else the print run ("/25") so a tile
 * always says what it is. Empty when neither is known.
 */
export function similarEditionParallelLabel(
  s: { external_id?: string | null; circulation_count: number | null },
  siblings: ReadonlyArray<{ external_id: string; subedition_name: string | null; circulation_count: number | null }>,
  // A parallel name known WITHOUT the ladder (Candy's Rainbow colour, see
  // candyParallelFromExternalId) — used only when no sibling names this edition.
  fallbackName?: string | null,
): string {
  const sib = s.external_id ? siblings.find((x) => x.external_id === s.external_id) : undefined
  const name = sib?.subedition_name?.trim() || fallbackName?.trim()
  const run = s.circulation_count ?? sib?.circulation_count ?? null
  if (name && run != null) return ` · ${name} /${run.toLocaleString("en-US")}`
  if (name) return ` · ${name}`
  if (run != null) return ` · /${run.toLocaleString("en-US")}`
  return ""
}

/**
 * Candy MLB (2026-09-25): a Rainbow parallel's colour, from its external_id.
 * Candy has no printing ladder, so its Similar editions showed two identical
 * "Mike Trout · LEGENDARY · … · /15" tiles. The external_id is the player slug
 * plus the colour (`mike-trout-pink`, `bobby-witt-jr-blue`), and the slug rule is
 * verified against all 125 editions: lowercase, NON-ASCII DROPPED (José Ramírez
 * → `jos-ramrez`), runs of space/dash → one dash, punctuation dropped. The base
 * card's external_id IS the slug, so it returns null — never a fabricated colour.
 */
export function candyParallelFromExternalId(
  externalId: string | null | undefined,
  playerName: string | null | undefined,
): string | null {
  if (!externalId || !playerName) return null
  const slug = playerName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
  if (!slug || !externalId.startsWith(`${slug}-`)) return null
  const suffix = externalId.slice(slug.length + 1)
  if (!/^[a-z]+$/.test(suffix)) return null
  return suffix.charAt(0).toUpperCase() + suffix.slice(1)
}
