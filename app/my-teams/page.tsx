// app/my-teams/page.tsx
// Team Hub Phase 5 (G3). Auth-gated cross-collection fan hub: one branded card
// per team the user follows (NBA / WNBA / NFL / LaLiga), each with checklist
// completion + cost-to-complete auto-bound to the user's saved wallet.
//
// Auth: the page reads the user + their favorites + saved wallet through the
// authenticated SESSION client (RLS / auth.uid()); get_my_fan_teams is granted
// to `authenticated` only. Public team data (detail + checklist progress) is
// read with the service-role admin client. proxy.ts also gates /my-teams (not
// in the public allowlist) — the in-page redirect is the defensive mirror.

import { redirect } from "next/navigation"
import Link from "next/link"
import type { Metadata } from "next"
import { getCurrentUser, getSupabaseServer } from "@/lib/auth/supabase-server"
import { getCollectionByUuid } from "@/lib/collection-slug"
import { fmtTeamUsd, fmtTeamCount, teamLogoUrl } from "@/lib/fan-teams-format"
import {
  fetchFanTeams,
  fetchBoundWallet,
  fetchTeamCard,
  type FanTeam,
  type TeamDetail,
  type TeamProgress,
} from "@/lib/fan-teams/fetchers"
import TeamLogo from "@/components/entity/TeamLogo"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "My Teams",
  description: "Your followed teams across NBA Top Shot, WNBA, NFL All Day, and LaLiga Golazos — checklist completion, cost-to-complete, and market activity in one hub.",
  robots: { index: false, follow: false },
}

const LEAGUE_ORDER = ["NBA", "WNBA", "NFL", "LALIGA"]
const LEAGUE_LABEL: Record<string, string> = { NBA: "NBA", WNBA: "WNBA", NFL: "NFL", LALIGA: "LaLiga" }

// fmtUsd/fmtCount/logoFor extracted to lib/fan-teams-format.ts (measured + tested).
const fmtUsd = fmtTeamUsd
const fmtCount = fmtTeamCount
const logoFor = teamLogoUrl

export default async function MyTeamsPage() {
  const user = await getCurrentUser()
  if (!user) redirect("/login?next=/my-teams")

  const session = await getSupabaseServer()
  const { teams, ok: teamsOk } = await fetchFanTeams(session)
  const { wallet, ok: walletOk } = await fetchBoundWallet(session, user.id)

  // ⚠ A FAILED read must not tell a collector they follow nothing. Zero teams
  // renders "Follow a team to build your hub" with two suggestions — right for
  // a new account, and an invitation to start over for someone who follows six.
  // The failure branch must come FIRST, or the fix is inert.
  if (!teamsOk) {
    return (
      <div>
        <PageHeading />
        <div className="rpc-card" style={{ padding: 28, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
            Your teams couldn&rsquo;t be loaded
          </div>
          <div style={{ color: "var(--rpc-text-muted)", fontSize: 14, lineHeight: 1.5 }}>
            This is a problem on our side and says nothing about which teams you follow — they are still there. Reload in a moment.
          </div>
        </div>
      </div>
    )
  }

  // Empty state — no follows yet.
  if (teams.length === 0) {
    return (
      <div>
        <PageHeading />
        <div className="rpc-card" style={{ padding: 28, textAlign: "center" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800, marginBottom: 8 }}>
            Follow a team to build your hub
          </div>
          <div style={{ color: "var(--rpc-text-muted)", fontSize: 14, marginBottom: 18, lineHeight: 1.5 }}>
            Pick your team on any team page and it shows up here with checklist completion, cost-to-complete, and market activity — across every collection you follow.
          </div>
          <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
            <Link href="/nba-top-shot/team/portland-trail-blazers" className="rpc-mono" style={pillLink}>Portland Trail Blazers →</Link>
            <Link href="/nba-top-shot/team/new-york-liberty" className="rpc-mono" style={pillLink}>New York Liberty →</Link>
          </div>
        </div>
      </div>
    )
  }

  const cards = await Promise.all(teams.map((t) => fetchTeamCard(t, wallet)))
  const enriched = teams.map((team, i) => ({ team, ...cards[i] }))

  // Group by league in canonical order.
  const byLeague = LEAGUE_ORDER
    .map((lg) => ({ league: lg, rows: enriched.filter((e) => e.team.league === lg) }))
    .filter((g) => g.rows.length > 0)

  return (
    <div>
      <PageHeading />
      {/* ⚠ `walletOk &&` is load-bearing: an unread wallet is not an absent one,
          and this copy tells its owner to add the wallet they already added.
          Omitting the prompt understates — the safe direction — where asserting
          it makes a false claim about the reader's own profile. */}
      {walletOk && !wallet && (
        <div
          className="rpc-mono"
          style={{
            marginBottom: 18,
            padding: "10px 14px",
            border: "1px solid var(--rpc-border)",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--rpc-text-muted)",
          }}
        >
          Add a wallet address or Top Shot username on your profile to see your completion % and what each team costs you to finish.
        </div>
      )}

      {byLeague.map((group) => (
        <section key={group.league} style={{ marginBottom: 28 }}>
          <div
            className="rpc-mono"
            style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 10 }}
          >
            {LEAGUE_LABEL[group.league] ?? group.league}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 14 }}>
            {group.rows.map(({ team, detail, progress }) => (
              <TeamCard key={`${team.league}:${team.route_slug}`} team={team} detail={detail} progress={progress} hasWallet={!!wallet} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function PageHeading() {
  return (
    <div style={{ marginBottom: 20 }}>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 900,
          fontSize: 30,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          margin: 0,
          borderBottom: "2px solid var(--rpc-red)",
          paddingBottom: 8,
          display: "inline-block",
        }}
      >
        My Teams
      </h1>
    </div>
  )
}

const pillLink: React.CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  border: "1px solid var(--rpc-red)",
  borderRadius: 999,
  color: "var(--rpc-red)",
  fontSize: 12,
  textDecoration: "none",
  letterSpacing: "0.04em",
}

function TeamCard({
  team,
  detail,
  progress,
  hasWallet,
}: {
  team: FanTeam
  detail: TeamDetail | null
  progress: TeamProgress | null
  hasWallet: boolean
}) {
  const coll = getCollectionByUuid(team.collection_id)
  const urlSlug = coll?.urlSlug ?? "nba-top-shot"
  const hubHref = `/${urlSlug}/team/${team.route_slug}`

  const primary = team.primary_color || "var(--rpc-surface)"
  const accent = team.secondary_color || "var(--rpc-red)"
  const gradient = team.primary_color
    ? `linear-gradient(105deg, ${primary} 0%, var(--rpc-surface) 92%)`
    : "var(--rpc-surface)"

  const pct = progress?.completion_pct
  const owned = progress?.owned ?? 0
  const total = progress?.total ?? 0
  const locked = progress?.locked_owned ?? 0
  const cost = progress?.cost_to_complete_usd

  return (
    <Link
      href={hubHref}
      className="rpc-card"
      style={{ padding: 0, overflow: "hidden", borderTop: `3px solid ${accent}`, textDecoration: "none", color: "inherit", display: "block" }}
    >
      {/* Branded header */}
      <div style={{ background: gradient, padding: 14, display: "flex", gap: 12, alignItems: "center", position: "relative" }}>
        <div style={{ transform: "scale(0.62)", transformOrigin: "left center", width: 96, height: 60, flex: "0 0 auto" }}>
          <TeamLogo logoUrl={logoFor(team)} abbreviation={team.abbreviation} secondaryColor={team.secondary_color} />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              fontSize: 19,
              letterSpacing: "0.03em",
              textTransform: "uppercase",
              color: team.primary_color ? "#fff" : "var(--rpc-text-primary)",
              textShadow: team.primary_color ? "0 1px 6px rgba(0,0,0,0.45)" : "none",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {team.team_name}
          </div>
          <div className="rpc-mono" style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
            {team.abbreviation && (
              <span style={{ fontSize: 10, letterSpacing: "0.1em", color: team.primary_color ? "rgba(255,255,255,0.85)" : "var(--rpc-text-muted)" }}>
                {team.abbreviation}
              </span>
            )}
            <span style={{ fontSize: 10, letterSpacing: "0.1em", color: team.primary_color ? "rgba(255,255,255,0.7)" : "var(--rpc-text-muted)" }}>
              {LEAGUE_LABEL[team.league] ?? team.league}
            </span>
          </div>
        </div>
        {team.is_primary && (
          <span
            className="rpc-mono"
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              fontSize: 9,
              fontWeight: 800,
              letterSpacing: "0.08em",
              padding: "3px 7px",
              borderRadius: 4,
              background: "var(--rpc-red)",
              color: "#fff",
            }}
          >
            ★ PRIMARY
          </span>
        )}
      </div>

      {/* Checklist completion */}
      <div style={{ padding: 14 }}>
        {hasWallet && pct != null ? (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
              <span className="rpc-mono" style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>
                Checklist
              </span>
              <span className="rpc-mono" style={{ fontSize: 13, fontWeight: 800, color: "var(--rpc-red)" }}>
                {Math.round(Number(pct))}%
              </span>
            </div>
            <div style={{ width: "100%", height: 6, background: "var(--rpc-border)", borderRadius: 3, overflow: "hidden", marginBottom: 8 }}>
              <div style={{ width: `${Math.max(0, Math.min(100, Number(pct)))}%`, height: "100%", background: "var(--rpc-red)" }} />
            </div>
            <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
              {fmtCount(owned)} / {fmtCount(total)} owned{locked > 0 ? ` · ${fmtCount(locked)} locked` : ""}
            </div>
          </>
        ) : (
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
            {fmtCount(total)} editions in the all-time checklist
          </div>
        )}

        {/* Stat row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginTop: 12 }}>
          <Stat label="Cost to finish" value={fmtUsd(cost)} />
          <Stat label="30d sales" value={fmtCount(detail?.sales_30d)} />
          <Stat label="30d volume" value={fmtUsd(detail?.volume_30d_usd == null ? null : Number(detail.volume_30d_usd))} />
        </div>

        <div className="rpc-mono" style={{ marginTop: 12, fontSize: 11, color: "var(--rpc-red)", letterSpacing: "0.04em" }}>
          Open team hub →
        </div>
      </div>
    </Link>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 2 }}>
        {label}
      </div>
      <div className="rpc-mono" style={{ fontSize: 13, fontWeight: 700, color: "var(--rpc-text-primary)" }}>
        {value}
      </div>
    </div>
  )
}
