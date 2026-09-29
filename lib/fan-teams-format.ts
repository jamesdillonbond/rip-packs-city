// Pure display helpers for the /my-teams page (app/my-teams/page.tsx).
//
// Extracted verbatim from the server page (measured by NEITHER coverage gate) so
// the compact formatters and — the one with real branch logic — the official-CDN
// team-logo URL resolver are measured + unit-tested. teamLogoUrl mirrors
// TeamHero: NBA + WNBA get a league-specific CDN SVG keyed by external_id; every
// other league (and any team with no external_id) falls back to the abbreviation
// badge (null). A regression here 404s a real logo or, worse, points one league's
// team at the other league's CDN.

import { usdSignFirst } from "@/lib/usd-format"

export interface TeamLogoInput {
  league: string
  external_id: string | null
}

export function fmtTeamUsd(v: number | null | undefined): string {
  const neg = usdSignFirst(v, fmtTeamUsd); if (neg !== null) return neg
  if (v == null || !Number.isFinite(Number(v))) return "—"
  return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: 0 })
}

export function fmtTeamCount(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(Number(v))) return "—"
  return Number(v).toLocaleString("en-US")
}

export function teamLogoUrl(t: TeamLogoInput): string | null {
  if (!t.external_id) return null
  const league = t.league.toUpperCase()
  // Same-origin, rasterized: Chrome fails cdn.nba.com / cdn.wnba.com directly with
  // ERR_HTTP2_PROTOCOL_ERROR (2026-09-29). See app/api/public/team-logo/[league]/[id]/route.ts.
  if (league === "NBA") return `/api/public/team-logo/nba/${encodeURIComponent(String(t.external_id))}`
  if (league === "WNBA") return `/api/public/team-logo/wnba/${encodeURIComponent(String(t.external_id))}`
  return null
}
