// Notable-tag → legacy badge_type mapping for the moment detail page.
// Extracted verbatim from app/moment/[id]/page.tsx so this ALLOWLIST — the
// gate that decides which special-serial chips a moment earns — is exercised by
// the primary coverage gate (a wrong entry here fabricates a badge, or drops a
// real one). The map is intentionally strict: only #1 / jersey / last_mint
// tags map through; anything else is dropped. Pure; behaviour byte-identical.

export const NOTABLE_TAG_TO_BADGE_TYPE: Record<string, string> = {
  "#1": "first_serial",
  jersey: "jersey_match",
  last_mint: "perfect_mint",
}

// Filter the edition-wide notable-serial rows to the current serial and remap
// each surviving row's tag into the legacy badge_type vocabulary. A row whose
// serial doesn't match, or whose tag isn't in the allowlist, is dropped.
export function mapNotableTagsToSpecialSerials(
  rows: Array<{ serial: number | null; tag: string | null }>,
  serial: number,
): Array<{ badge_type: string; serial_number: number }> {
  return rows.flatMap((n) => {
    if (n.serial !== serial) return []
    const badgeType = NOTABLE_TAG_TO_BADGE_TYPE[n.tag ?? ""]
    if (!badgeType) return []
    return [{ badge_type: badgeType, serial_number: serial }]
  })
}
