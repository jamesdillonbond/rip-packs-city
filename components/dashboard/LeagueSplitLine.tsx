"use client"

// components/dashboard/LeagueSplitLine.tsx
//
// The line under the dashboard's Panini and Candy tiles (2026-11-26): the account's cards by league / brand
// — "NFL 3,647 · NBA 1,556 · +11 more". Optional detail: while loading, on a failed read, or when everything
// sits under one league, it renders NOTHING (the tile's own count stands; no absence is stated).

import { useEffect, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { leagueSplitLine, toLeagueSplit } from "@/lib/league-split"

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
