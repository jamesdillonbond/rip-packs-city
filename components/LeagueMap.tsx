// components/LeagueMap.tsx
//
// The coverage map's view (/leagues, 2026-11-26): one tile per league or brand, listing every place its
// cards live on RPC. Pure props (lib/league-map.ts builds them). ⛔ Two headings — "Leagues" and
// "Entertainment" — and no umbrella word; a publisher whose list failed to load is named, never implied empty.

import Link from "next/link"
import type { LeagueMapEntry } from "@/lib/league-map"

function Tile({ e }: { e: LeagueMapEntry }) {
  return (
    <li data-testid={`league-${e.key}`} className="rpc-card" style={{ padding: "14px 16px", listStyle: "none" }}>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", lineHeight: 1.15 }}>
        {e.name}
      </div>
      <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>{e.category}</div>
      <ul style={{ listStyle: "none", margin: "10px 0 0", padding: 0, display: "grid", gap: 6 }}>
        {e.sources.map((s) => (
          <li key={s.href}>
            <Link prefetch={false} href={s.href} className="rpc-tap44" style={{ display: "block", textDecoration: "none", color: "inherit" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>{s.label} →</span>
              {s.detail ? <span className="rpc-mono" style={{ display: "block", fontSize: 11, color: "var(--rpc-text-secondary)" }}>{s.detail}</span> : null}
            </Link>
          </li>
        ))}
        {e.teamHubs ? (
          <li>
            <Link prefetch={false} href="/teams" className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
              {e.name} team hubs →
            </Link>
          </li>
        ) : null}
      </ul>
    </li>
  )
}

function Group({ id, title, entries }: { id: string; title: string; entries: LeagueMapEntry[] }) {
  if (entries.length === 0) return null
  return (
    <section data-testid={`league-map-${id}`} style={{ marginTop: 22 }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 20, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 10px" }}>
        {title}
      </h2>
      <ul style={{ margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
        {entries.map((e) => <Tile key={e.key} e={e} />)}
      </ul>
    </section>
  )
}

export default function LeagueMap({ leagues, entertainment, failed }: { leagues: LeagueMapEntry[]; entertainment: LeagueMapEntry[]; failed: string[] }) {
  return (
    <div data-testid="league-map">
      {failed.length > 0 ? (
        <div role="status" data-testid="league-map-partial" className="rpc-mono" style={{ marginTop: 12, padding: "10px 12px", border: "1px solid var(--rpc-border)", borderRadius: 6, fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          Couldn&rsquo;t load {failed.join(" and ")}&rsquo;s list just now, so {failed.length === 1 ? "its" : "their"} leagues and brands are missing below. That is a problem on our side, not a gap in what {failed.length === 1 ? "it covers" : "they cover"}. Reloading often works.
        </div>
      ) : null}
      <Group id="leagues" title="Leagues" entries={leagues} />
      <Group id="entertainment" title="Entertainment" entries={entertainment} />
    </div>
  )
}
