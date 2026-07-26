// Pure label/subject derivations for the moment detail page
// (app/moment/[id]/page.tsx). Extracted so the SEO subject line and the
// special-serial / notable-tag enum→label maps are unit-tested.

import { joinMetaParts, metaField } from "@/lib/format"

/**
 * A moment's display subject for titles / meta descriptions / JSON-LD:
 * player → "<team> <play>" (team moments, no player) → raw name → "Moment".
 * Values are trimmed via metaField because every caller joins this into a meta
 * tag, so a stray space in the catalog column showed up as "Simba , Set".
 */
export function momentSubject(
  player: string | null | undefined,
  team: string | null | undefined,
  play: string | null | undefined,
  name: string | null | undefined,
): string {
  const playerName = metaField(player)
  if (playerName) return playerName
  const teamName = metaField(team)
  if (teamName) {
    const playType = metaField(play)
    return joinMetaParts([teamName, playType !== "Unknown" ? playType : null], " ")
  }
  return metaField(name) ?? "Moment"
}

/** notable_serials tag → display label; unknown tags de-underscore. */
export function notableTagLabel(tag: string): string {
  switch (tag) {
    case "#1": return "Serial #1"
    case "jersey": return "Jersey Match"
    case "last_mint": return "Perfect Serial"
    default: return tag.replace(/_/g, " ")
  }
}

/** special_serial_holders.badge_type enum → display label; unknown de-underscores. */
export function specialSerialLabel(badge_type: string): string {
  switch (badge_type) {
    case "first_serial": return "#1 Serial"
    case "jersey_match": return "Jersey Match"
    case "perfect_mint": return "Perfect Serial"
    case "last_serial": return "Perfect Serial"
    case "birthdate_serial": return "Birthdate"
    default: return badge_type.replace(/_/g, " ")
  }
}
