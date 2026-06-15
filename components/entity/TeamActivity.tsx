// components/entity/TeamActivity.tsx
// Team Hub Phase 3 (C8). Server component. Recent team sales table + a "Biggest
// recent sales" subhead derived by sorting the same fetched window by price.
// Data (get_team_activity via /api/entity/team-activity) is fetched server-side
// in the team page and passed in.

import Link from "next/link"
import { EM_DASH, fmtUsd, relTime, marketplaceLabel, tileSubject } from "./_shared"

export interface ActivityRow {
  route_slug: string
  player_name: string | null
  set_name: string | null
  // Team-moment display: team moments (player_name null) read "{team} {play}".
  team_name?: string | null
  play_type?: string | null
  tier: string | null
  thumbnail_url: string | null
  serial_number: number | null
  price_usd: number | null
  sold_at: string | null
  marketplace: string | null
}

function MomentLink({ collectionUrlSlug, row }: { collectionUrlSlug: string; row: ActivityRow }) {
  return (
    <Link
      href={`/${collectionUrlSlug}/edition/${encodeURIComponent(row.route_slug)}`}
      style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: "var(--font-display)", fontWeight: 700, letterSpacing: "0.02em" }}
    >
      {tileSubject({ player_name: row.player_name, team_name: row.team_name, play_type: row.play_type, name: row.set_name })}
    </Link>
  )
}

function Row({ collectionUrlSlug, r, showTime }: { collectionUrlSlug: string; r: ActivityRow; showTime: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "center", padding: "8px 0", borderBottom: "1px solid var(--rpc-border-subtle)" }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <MomentLink collectionUrlSlug={collectionUrlSlug} row={r} />
        </div>
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {r.set_name ?? EM_DASH}{r.serial_number != null ? ` · #${r.serial_number}` : ""}{r.marketplace ? ` · ${marketplaceLabel(r.marketplace)}` : ""}
        </div>
      </div>
      <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>{fmtUsd(r.price_usd)}</div>
        {showTime && <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{relTime(r.sold_at)}</div>}
      </div>
    </div>
  )
}

export default function TeamActivity({ collectionUrlSlug, rows }: { collectionUrlSlug: string; rows: ActivityRow[] }) {
  if (!rows || rows.length === 0) {
    return <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>No recent sales.</div>
  }
  const recent = rows.slice(0, 15)
  const biggest = [...rows]
    .filter(r => (r.price_usd ?? 0) > 0)
    .sort((a, b) => (b.price_usd ?? 0) - (a.price_usd ?? 0))
    .slice(0, 5)

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 18 }}>
      <div>
        <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 6 }}>Recent sales</div>
        {recent.map((r, i) => <Row key={`${r.route_slug}-${r.sold_at}-${i}`} collectionUrlSlug={collectionUrlSlug} r={r} showTime />)}
      </div>
      {biggest.length > 0 && (
        <div>
          <div className="rpc-mono" style={{ fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 6 }}>Biggest recent sales</div>
          {biggest.map((r, i) => <Row key={`big-${r.route_slug}-${i}`} collectionUrlSlug={collectionUrlSlug} r={r} showTime={false} />)}
        </div>
      )}
    </div>
  )
}
