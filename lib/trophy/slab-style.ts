// Pure style/derivation helpers for the trophy slab (components/TrophySlab.tsx)
// and the trophy-case PDF export. Extracted verbatim so the tier→color mapping,
// the badge-slug normalization, and the Top Shot hi-res thumbnail rewrite are
// unit-tested and covered by the ratchet — these drive brand-critical, user-
// facing artwork, and a wrong tier accent or a mis-rewritten media URL ships a
// visibly broken slab.
import { ownLookup } from "@/lib/safe-lookup"

export const BADGE_COLORS: Record<string, string> = {
  jersey_match: "#A78BFA",
  rookie_mint: "#A78BFA",
  top_shot_debut: "#F472B6",
  rookie_year: "#F472B6",
  rookie_premiere: "#60A5FA",
  rookie_of_the_year: "#F59E0B",
  three_stars: "#FFD700",
  three_star_rookie: "#FFD700",
  perfect_mint: "#FFD700",
  championship: "#34D399",
  championship_year: "#34D399",
}

export function badgeColor(slug: string): string {
  // Normalize a badge title/slug ("Rookie Mint" -> "rookie_mint") so the no-art
  // dot fallback still resolves a distinct color per badge type.
  const key = slug.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")
  return ownLookup(BADGE_COLORS, key) ?? ownLookup(BADGE_COLORS, slug) ?? "#94A3B8"
}

export function tierKey(tier: string | null): string {
  return (tier ?? "common").toLowerCase()
}

export function tierAccent(tier: string | null): string {
  switch (tierKey(tier)) {
    case "legendary": return "#B89000"
    case "ultimate": return "#D4521E"
    case "rare":
    case "challenger": return "#5654C7"
    case "fandom": return "#0F8E5E"
    case "common":
    case "contender": return "#5A6B7D"
    default: return "#5A6B7D"
  }
}

export function tierBorder(tier: string | null): string {
  switch (tierKey(tier)) {
    case "legendary": return "var(--tier-legendary-border)"
    case "ultimate": return "var(--tier-ultimate-border)"
    case "rare": return "var(--tier-rare-border)"
    case "fandom": return "var(--tier-fandom-border)"
    case "common": return "var(--tier-common-border)"
    case "challenger": return "var(--tier-challenger-border)"
    case "contender": return "var(--tier-contender-border)"
    default: return "var(--rpc-border)"
  }
}

export function tierGlow(tier: string | null): string {
  switch (tierKey(tier)) {
    case "legendary": return "rgba(255,215,0,0.10)"
    case "ultimate": return "rgba(255,107,53,0.10)"
    case "rare":
    case "challenger": return "rgba(129,140,248,0.08)"
    case "fandom": return "rgba(52,211,153,0.08)"
    case "common":
    case "contender": return "rgba(148,163,184,0.05)"
    default: return "rgba(148,163,184,0.05)"
  }
}

export function tierHoloClass(tier: string | null): string {
  switch (tierKey(tier)) {
    case "legendary": return "rpc-holo-legendary"
    case "ultimate": return "rpc-holo-ultimate"
    case "rare": return "rpc-holo-rare"
    default: return ""
  }
}

// Top Shot media URLs bake a width into the stored still (many are width=180,
// which upscales blurry into the slab screen). Bump Top Shot media to 640 so
// the still is crisp; other hosts (AllDay already 512, the Pinnacle proxy) pass
// through unchanged.
export function hiResThumb(url: string | null | undefined): string | undefined {
  if (!url) return undefined
  if (url.includes("assets.nbatopshot.com")) {
    return /[?&]width=\d+/.test(url)
      ? url.replace(/([?&]width=)\d+/, "$1640")
      : url + (url.includes("?") ? "&" : "?") + "width=640"
  }
  return url
}
