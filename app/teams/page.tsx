// /teams — the directory of chain-agnostic team hubs (2026-09-25).
//
// The hubs (/teams/<league>/<slug>, shipped 09-23) were reachable only from a
// per-collection team page's "across every collection →" link; /teams itself
// was a 404 (and, under the proxy's fail-closed allowlist, a login redirect
// for an anonymous visitor). This page lists every registered franchise by
// league — 127 today across NBA, WNBA, NFL, LaLiga and MLB — so a collector
// can browse "which teams does RPC cover" and a crawler has one indexable
// directory (the hubs themselves stay noindex while each league maps to a
// single collection; see hubIsIndexable).
//
// Data access lives in lib/franchise-directory.ts ({ state } per league) so
// this page adds no inline reader to the server-page data-access ratchet.
// A league whose read failed says so; it is never rendered as "no teams".

import type { Metadata } from "next"
import Link from "next/link"
import { franchiseHubMetadata } from "@/lib/seo"
import { franchiseHubPath } from "@/lib/franchise-hub"
import { fetchFranchiseDirectory, type DirectoryLeague } from "@/lib/franchise-directory"
import { Section, SectionUnavailable } from "@/components/entity/_shared"
import Breadcrumbs from "@/components/entity/Breadcrumbs"

export const revalidate = 3600

const SITE = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = franchiseHubMetadata({
  name: "Team Hubs — every franchise across every collection",
  description:
    "Browse every NBA, WNBA, NFL, LaLiga and MLB franchise Rip Packs City tracks. Each team hub gathers its digital collectibles across collections — editions, fair market value and recent market activity.",
  canonical: `${SITE}/teams`,
})

export default async function TeamsDirectoryPage() {
  const dir = await fetchFranchiseDirectory()

  return (
    <div>
      <Breadcrumbs items={[{ name: "Home", href: "/" }, { name: "Teams" }]} />
      <header style={{ marginTop: 8, marginBottom: 6 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 900,
            fontSize: 28,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "var(--rpc-text-primary)",
            margin: 0,
          }}
        >
          Team Hubs
        </h1>
        <p className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)", margin: "6px 0 0", lineHeight: 1.6, maxWidth: 640 }}>
          One page per franchise, gathering its collectibles across every collection Rip Packs City covers. Pick a team
          to see its editions, fair market value and recent sales.
        </p>
      </header>

      {dir.okLeagues === 0 ? (
        // Every league read failed: a platform problem, not an empty directory.
        <Section title="Teams">
          <SectionUnavailable noun="the team directory" />
        </Section>
      ) : (
        dir.leagues.map((l) => <LeagueSection key={l.league} league={l} />)
      )}
    </div>
  )
}

function LeagueSection({ league }: { league: DirectoryLeague }) {
  return (
    <Section title={`${league.emoji} ${league.label}`} action={league.state === "ok" ? <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>{league.teams.length} teams</span> : undefined}>
      {league.state === "failed" ? (
        <SectionUnavailable noun={`${league.label} teams`} />
      ) : league.teams.length === 0 ? (
        // The read ANSWERED with no rows — a measured absence.
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
          No {league.label} teams are registered yet.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 200px), 1fr))", gap: 10 }}>
          {league.teams.map((t) => (
            <Link
              key={t.slug}
              href={franchiseHubPath(league.league, t.slug)}
              className="rpc-card"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 12px",
                textDecoration: "none",
                color: "inherit",
                borderLeft: `4px solid ${t.primary_color || "var(--rpc-border-subtle)"}`,
              }}
            >
              <span
                aria-hidden="true"
                className="rpc-mono"
                style={{
                  minWidth: 40,
                  textAlign: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  padding: "3px 0",
                  borderRadius: 4,
                  background: t.primary_color || "var(--rpc-surface, rgba(255,255,255,0.04))",
                  // brand-exception: a team's own colours are theme-independent
                  color: t.secondary_color || "#fff",
                }}
              >
                {t.abbreviation || "—"}
              </span>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, letterSpacing: "0.03em", lineHeight: 1.2, color: "var(--rpc-text-primary)" }}>
                {t.team_name}
              </span>
            </Link>
          ))}
        </div>
      )}
    </Section>
  )
}
