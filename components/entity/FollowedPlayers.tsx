// components/entity/FollowedPlayers.tsx
import Link from "next/link"
import type { CSSProperties } from "react"
import type { FollowedPlayer } from "@/lib/fan-teams/followed-players"
import { playerHubPath } from "@/lib/player-hub-path"

const pillLink: CSSProperties = {
  display: "inline-block",
  padding: "8px 16px",
  border: "1px solid var(--rpc-red)",
  borderRadius: 999,
  color: "var(--rpc-red-text)",
  fontSize: 12,
  textDecoration: "none",
  letterSpacing: "0.04em",
}

// 2026-10-31: followed players (webz_80's request, feedback 11800). Three states:
// a failed read says so (never "you follow no players"), none yet, or the list.
export default function FollowedPlayers({ players, ok }: { players: FollowedPlayer[]; ok: boolean }) {
  return (
    <section data-rpc-followed-players style={{ marginTop: 28, marginBottom: 28 }}>
      <div className="rpc-mono" style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 10 }}>
        Players you follow
      </div>
      {!ok ? (
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
          Your followed players couldn&rsquo;t be loaded. They are still saved — reload in a moment.
        </div>
      ) : players.length === 0 ? (
        <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
          Follow a player with the ☆ Follow player button on any player page and they show up here, one tap from their checklist and every collection they appear in.
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {players.map((p) => (
            <Link
              key={`${p.collection ?? ""}:${p.slug}`}
              href={p.collection ? `/${p.collection}/player/${encodeURIComponent(p.slug)}` : playerHubPath(p.slug)}
              className="rpc-mono"
              style={pillLink}
            >
              {p.name} →
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}

