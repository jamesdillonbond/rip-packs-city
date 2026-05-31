// components/entity/TeamSqueeze.tsx
// Team Hub Phase 3 (C8). Server component. Ranked squeeze table (effective-supply
// lock+burn) for the team, from get_team_squeeze via /api/entity/team-squeeze.
// Top Shot-only (the RPC returns [] elsewhere); the team page only renders the
// section when rows are non-empty, so this self-hides for other collections.

import Link from "next/link"
import { EM_DASH, fmtUsd, fmtCount, TierBadge } from "./_shared"

export interface SqueezeRow {
  route_slug: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  squeeze_pct: number | null
  lock_pct: number | null
  burn_pct: number | null
  effectively_buyable: number | null
  circulation: number | null
  low_ask: number | null
  fmv_usd: number | null
  thumbnail_url: string | null
}

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return EM_DASH
  return `${n.toFixed(0)}%`
}

export default function TeamSqueeze({ collectionUrlSlug, rows }: { collectionUrlSlug: string; rows: SqueezeRow[] }) {
  if (!rows || rows.length === 0) return null
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginBottom: 8 }}>
        Ranked by effective-supply squeeze (locked + burned). Fewer buyable copies = tighter supply.
      </div>
      {rows.map((r, i) => (
        <Link
          key={`${r.route_slug}-${i}`}
          href={`/${collectionUrlSlug}/edition/${encodeURIComponent(r.route_slug)}`}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) auto auto auto",
            gap: 10,
            alignItems: "center",
            padding: "9px 0",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            textDecoration: "none",
            color: "inherit",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.player_name ?? "Edition"}
            </div>
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.set_name ?? EM_DASH}
            </div>
          </div>
          <TierBadge tier={r.tier} />
          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: "var(--rpc-red)" }}>{pct(r.squeeze_pct)}</div>
            <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.10em" }}>SQUEEZE</div>
          </div>
          <div style={{ textAlign: "right", whiteSpace: "nowrap" }}>
            <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>
              {r.effectively_buyable != null ? fmtCount(r.effectively_buyable) : EM_DASH}<span style={{ color: "var(--rpc-text-ghost)" }}> / {r.circulation != null ? fmtCount(r.circulation) : EM_DASH}</span>
            </div>
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
              ask {r.low_ask != null && r.low_ask > 0 ? fmtUsd(r.low_ask) : EM_DASH}
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}
