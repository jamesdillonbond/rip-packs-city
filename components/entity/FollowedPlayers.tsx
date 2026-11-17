// components/entity/FollowedPlayers.tsx
import Link from "next/link"
import type { CSSProperties } from "react"
import type { FollowedPlayer } from "@/lib/fan-teams/followed-players"
import { playerHubPath } from "@/lib/player-hub-path"
import { getEntityLabels } from "@/lib/entity-labels"
import { playerPagePath } from "@/lib/player-route"

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
// Disney Pinnacle follows are CHARACTERS (lib/entity-labels), listed under their own
// heading — the site never calls a Pinnacle character a player.
export default function FollowedPlayers({ players, ok }: { players: FollowedPlayer[]; ok: boolean }) {
  const groups = new Map<string, FollowedPlayer[]>()
  for (const p of players) {
    const heading = `${getEntityLabels(p.collection ?? "").players} you follow`
    groups.set(heading, [...(groups.get(heading) ?? []), p])
  }
  return (
    <section data-rpc-followed-players style={{ marginTop: 28, marginBottom: 28 }}>
      {!ok ? (
        <>
          <Heading text="Players you follow" />
          <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)" }}>
            Your followed players and characters couldn&rsquo;t be loaded. They are still saved — reload in a moment.
          </div>
        </>
      ) : players.length === 0 ? (
        <>
          <Heading text="Players you follow" />
          <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
            Follow a player (or a Disney Pinnacle character) with the ☆ Follow button under their name and they show up here, one tap from their checklist and every collection they appear in.
          </div>
        </>
      ) : (
        [...groups.entries()].map(([heading, rows]) => (
          <div key={heading} style={{ marginBottom: 18 }}>
            <Heading text={heading} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              {rows.map((p) => (
                <Link
                  key={`${p.collection ?? ""}:${p.slug}`}
                  href={p.collection ? playerPagePath(p.collection, p.slug) : playerHubPath(p.slug)}
                  className="rpc-mono"
                  style={pillLink}
                >
                  {p.name} →
                </Link>
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  )
}

function Heading({ text }: { text: string }) {
  return (
    <div className="rpc-mono" style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)", marginBottom: 10 }}>
      {text}
    </div>
  )
}
