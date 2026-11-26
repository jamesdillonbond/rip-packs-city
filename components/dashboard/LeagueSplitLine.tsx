"use client"

// components/dashboard/LeagueSplitLine.tsx
//
// The line under the dashboard's Panini and Candy tiles (2026-11-26): the account's cards by league / brand
// — "NFL 3,647 · NBA 1,556 · +11 more". Optional detail: while loading, on a failed read, or when everything
// sits under one league, it renders NOTHING (the tile's own count stands; no absence is stated).

import { useEffect, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import Link from "next/link"
import { leagueSplitLine, toLeagueSplit, type LeagueSplit } from "@/lib/league-split"

export default function LeagueSplitLine({ publisher, owner }: { publisher: "panini" | "candy"; owner: string }) {
  const [line, setLine] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchJson<unknown>(`/api/league-split?publisher=${publisher}&owner=${encodeURIComponent(owner)}`).then((r) => {
      if (cancelled) return
      const split = r.ok ? toLeagueSplit(r.json) : null
      setLine(split ? leagueSplitLine(split) : null)
    })
    return () => {
      cancelled = true
    }
  }, [publisher, owner])
  if (!line) return null
  return (
    <div data-testid={`league-split-${publisher}`} style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
      {line}
    </div>
  )
}

/**
 * The Candy Binder's "By league or brand" strip (2026-11-26): every brand the wallet holds, each linking its
 * brand page. Information, not a filter — the Binder's paged read is one RPC shared by every collection and
 * is not scoped by brand. Renders nothing while loading, on a failed read, or for a one-brand wallet.
 */
export function LeagueSplitStrip({ publisher, owner, collection }: { publisher: "panini" | "candy"; owner: string; collection: string }) {
  const [split, setSplit] = useState<LeagueSplit | null>(null)
  useEffect(() => {
    let cancelled = false
    fetchJson<unknown>(`/api/league-split?publisher=${publisher}&owner=${encodeURIComponent(owner)}`).then((r) => {
      if (!cancelled) setSplit(r.ok ? toLeagueSplit(r.json) : null)
    })
    return () => {
      cancelled = true
    }
  }, [publisher, owner])
  if (!split || split.leagues.length < 2) return null
  return (
    <div data-testid="league-split-strip" className="rpc-mono" style={{ margin: "0 0 12px", fontSize: 12, color: "var(--rpc-text-secondary)", display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "baseline" }}>
      <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>By league or brand</span>
      {split.leagues.map((l) => (
        <Link key={l.slug} prefetch={false} href={`/${collection}/property/${encodeURIComponent(l.slug)}`} style={{ color: "var(--rpc-text-primary)" }}>
          {l.name} {l.cards.toLocaleString("en-US")}
        </Link>
      ))}
      {split.unplaced > 0 ? <span style={{ color: "var(--rpc-text-muted)" }}>{split.unplaced.toLocaleString("en-US")} not placed</span> : null}
    </div>
  )
}
