// lib/moment-detail-format.ts
//
// Pure formatters + collection/slug mappers for the /moment/[id] detail page,
// extracted from app/moment/[id]/page.tsx (the ~2,000-line monolith) so the
// display logic behind every price, date, tier colour, and drill-down href is
// unit-testable. These are the "silent $0 / wrong date / broken drill-down link"
// class of bug — they carry real null/branch logic but were previously untested
// because a page body is measured by neither coverage gate.
//
// Behaviour is byte-identical to the in-page originals; the page now imports
// them. `slugifyTeam`/`urlSlugForCollection` are deliberately kept as their own
// copies (not re-pointed at lib/entity-labels or lib/collections) to preserve
// the page's exact prior mapping — a "cleanup" that changed a slug here would
// silently break entity drill-down links.

/** Decode a URL-encoded route segment (Pinnacle legacy keys arrive percent-
 *  encoded). No-op for numeric nft_ids and uuids; falls back to the raw input
 *  on a malformed sequence rather than throwing. */
export function decodeMomentId(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** USD money: em-dash for null/non-finite (never a fake "$0"), thousands get
 *  comma grouping + whole dollars, small values keep cents. */
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + n.toFixed(2)
}

/** Relative age ("today" / "1d ago" / "3mo ago" / "2y ago"). Empty string for
 *  missing/unparseable input so the caller renders nothing rather than "NaN". */
export function fmtRelDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  const diffMs = Date.now() - ms
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000))
  if (days <= 0) return "today"
  if (days === 1) return "1d ago"
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months === 1) return "1mo ago"
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}

/** Absolute localized date ("Jan 5, 2026"). Empty string for missing/
 *  unparseable input. */
export function fmtAbsDate(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
}

/** Tier → CSS colour var (with a text-muted fallback). Handles both the Top
 *  Shot vocabulary (ULTIMATE/LEGENDARY/RARE/FANDOM/COMMON) and the UFC Strike
 *  one (CHALLENGER/CONTENDER/FANDOM); unknown tiers fall back to muted. */
export function tierColorVar(tier: string | null | undefined): string {
  const t = (tier ?? "").toUpperCase()
  if (t === "ULTIMATE") return "var(--rpc-ultimate, var(--rpc-red))"
  if (t === "LEGENDARY") return "var(--rpc-legendary, var(--rpc-red))"
  if (t === "RARE") return "var(--rpc-rare, var(--rpc-text-primary))"
  if (t === "FANDOM") return "var(--rpc-fandom, var(--rpc-text-muted))"
  if (t === "COMMON") return "var(--rpc-common, var(--rpc-text-muted))"
  // UFC Strike tier vocabulary (CHALLENGER / CONTENDER / FANDOM).
  if (t === "CHALLENGER") return "var(--tier-challenger, var(--rpc-red))"
  if (t === "CONTENDER") return "var(--tier-contender, var(--rpc-text-muted))"
  return "var(--rpc-text-muted)"
}

/** Human display label for a DB collection slug (uppercased brand name);
 *  unknown slugs fall back to the slug with underscores → spaces, uppercased. */
export function collectionLabel(slug: string | null | undefined): string {
  switch (slug) {
    case "nba_top_shot": return "NBA TOP SHOT"
    case "nfl_all_day": return "NFL ALL DAY"
    case "laliga_golazos": return "LALIGA GOLAZOS"
    case "ufc_strike": return "UFC STRIKE"
    case "disney_pinnacle": return "DISNEY PINNACLE"
    default: return (slug ?? "").toUpperCase().replace(/_/g, " ")
  }
}

/** DB collection slug → URL slug used in /<collection>/... links. Returns null
 *  for an unknown slug so the caller can suppress a link rather than build a
 *  broken one. */
export function urlSlugForCollection(dbSlug: string | null | undefined): string | null {
  switch (dbSlug) {
    case "nba_top_shot": return "nba-top-shot"
    case "nfl_all_day": return "nfl-all-day"
    case "laliga_golazos": return "laliga-golazos"
    case "ufc_strike": return "ufc-strike"
    case "disney_pinnacle": return "disney-pinnacle"
    default: return null
  }
}

/** Team name → URL slug (lowercase, diacritics stripped, non-alnum → dashes,
 *  trimmed). Mirror of lib/entity-labels.slugifyName, kept local so the page
 *  doesn't pull that lib's runtime — behaviour must stay identical. */
export function slugifyTeam(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}
