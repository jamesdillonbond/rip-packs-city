// Pure label/slug helpers for the edition detail page
// (app/(collections)/[collection]/edition/[slug]/page.tsx — a server component
// outside the coverage include). Extracted verbatim so the ratchet measures
// them: a regression in the fossil-slug 404 gate would leak duplicate-canonical
// URLs back to the crawler, and a wrong ASK_LABEL would render "Top Shot ask" on
// a non-Top-Shot edition page.

// Canonical TS slugs are `setID:playID` (no hyphen); the duplicate-canonical
// fossils are `<uuid>:<uuid>` (hyphenated). 404 them so the crawler drops the
// cluster cleanly. Scoped to Top Shot ONLY — UFC's canonical ids are uuid-like.
export function isTopShotFossilSlug(collection: string, decodedSlug: string): boolean {
  return collection === "nba-top-shot" && decodedSlug.includes("-")
}

// Collection-aware label for the lowest-ask cell. The value source differs per
// collection (Top Shot marketplace ask vs the V1-Dapper cross-market ask), so
// the label must not say "Top Shot ask" on a non-Top-Shot page.
export const ASK_LABEL: Record<string, string> = {
  "nba-top-shot": "Top Shot ask",
  "nfl-all-day": "All Day ask",
  "laliga-golazos": "Golazos ask",
  "disney-pinnacle": "Pinnacle ask",
  "ufc-strike": "UFC ask",
}

export function notableTagLabel(tag: string): string {
  switch (tag) {
    case "#1": return "Serial #1"
    case "jersey": return "Jersey Match"
    case "last_mint": return "Perfect Serial"
    default: return tag.replace(/_/g, " ")
  }
}
