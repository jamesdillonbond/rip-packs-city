"use client"

// components/entity/PlayersGridPaginated.tsx
// Phase 1E. Reusable paginated player tile grid used by Team pages.
// Team Hub Phase 1 (C3): adds a Current / All-Time roster toggle driven by
// players.is_active. The toggle only appears when at least one loaded player
// carries is_active === true — otherwise (Pinnacle franchises, or collections
// where the active flag isn't populated) it stays hidden and every player is
// shown, so the roster never renders empty.

import { useState } from "react"
import Link from "next/link"
import { EM_DASH, fmtCount, fmtUsd } from "./_shared"

export interface PlayerTile {
  name: string
  player_slug: string
  headshot_url: string | null
  jersey_number: number | null
  position: string | null
  edition_count: number | null
  total_circulation: number | null
  fmv_total_usd: number | null
  portrait_thumbnail: string | null
  is_active?: boolean | null
  is_rookie?: boolean | null
}

type SortKey = "fmv_desc" | "editions_desc" | "alpha"
type RosterView = "current" | "all"

interface Props {
  collectionUrlSlug: string
  fetchUrl: string
  initial: PlayerTile[]
  pageSize: number
  isFranchise: boolean
}

function compare(a: PlayerTile, b: PlayerTile, key: SortKey): number {
  switch (key) {
    case "fmv_desc": return (b.fmv_total_usd ?? 0) - (a.fmv_total_usd ?? 0)
    case "editions_desc": return (b.edition_count ?? 0) - (a.edition_count ?? 0)
    case "alpha": return (a.name ?? "").localeCompare(b.name ?? "")
  }
}

export default function PlayersGridPaginated({ collectionUrlSlug, fetchUrl, initial, pageSize }: Props) {
  const [rows, setRows] = useState<PlayerTile[]>(initial)
  const [offset, setOffset] = useState<number>(initial.length)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(initial.length < pageSize)
  const [sortKey, setSortKey] = useState<SortKey>("fmv_desc")
  const [view, setView] = useState<RosterView>("current")

  // Only offer the Current/All-Time toggle when we actually have active-roster
  // data among the loaded rows; otherwise defaulting to "current" would hide
  // everyone (e.g. Pinnacle, where is_active is always null).
  const hasActiveData = rows.some(r => r.is_active === true)
  const currentActive = hasActiveData && view === "current"

  const sorted = [...rows].sort((a, b) => compare(a, b, sortKey))
  const display = currentActive ? sorted.filter(r => r.is_active === true) : sorted

  async function loadMore() {
    if (loading || exhausted) return
    setLoading(true)
    try {
      const sep = fetchUrl.includes("?") ? "&" : "?"
      const url = `${fetchUrl}${sep}offset=${offset}&limit=${pageSize}`
      const r = await fetch(url, { cache: "no-store" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const next: PlayerTile[] = await r.json()
      const safe = Array.isArray(next) ? next : []
      setRows(prev => [...prev, ...safe])
      setOffset(prev => prev + safe.length)
      if (safe.length < pageSize) setExhausted(true)
    } catch {
      setExhausted(true)
    } finally {
      setLoading(false)
    }
  }

  if (rows.length === 0) {
    return <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>No entries yet.</div>
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        {hasActiveData && (
          <div style={{ display: "flex", gap: 6, marginRight: 4 }}>
            {([
              { v: "current", l: "Current" },
              { v: "all",     l: "All-Time" },
            ] as Array<{ v: RosterView; l: string }>).map(({ v, l }) => (
              <button
                key={v}
                type="button"
                onClick={() => setView(v)}
                className="rpc-chip"
                style={{
                  background: view === v ? "var(--rpc-red-bg)" : undefined,
                  borderColor: view === v ? "var(--rpc-red-border)" : undefined,
                  color: view === v ? "var(--rpc-red)" : undefined,
                  cursor: "pointer",
                }}
              >{l}</button>
            ))}
          </div>
        )}
        {([
          { k: "fmv_desc",      l: "FMV ↓" },
          { k: "editions_desc", l: "Editions ↓" },
          { k: "alpha",         l: "A → Z" },
        ] as Array<{ k: SortKey; l: string }>).map(({ k, l }) => (
          <button
            key={k}
            type="button"
            onClick={() => setSortKey(k)}
            className="rpc-chip"
            style={{
              background: sortKey === k ? "var(--rpc-red-bg)" : undefined,
              borderColor: sortKey === k ? "var(--rpc-red-border)" : undefined,
              color: sortKey === k ? "var(--rpc-red)" : undefined,
              cursor: "pointer",
            }}
          >{l}</button>
        ))}
      </div>
      {currentActive && (
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginBottom: 10, letterSpacing: "0.04em" }}>
          Current = active per our roster data; some players may be unflagged.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {display.map(p => (
          <Link
            key={p.player_slug}
            href={`/${collectionUrlSlug}/player/${encodeURIComponent(p.player_slug)}`}
            className="rpc-card"
            style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block" }}
          >
            <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.35)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
              {(p.headshot_url ?? p.portrait_thumbnail) ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={(p.headshot_url ?? p.portrait_thumbnail) ?? undefined} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>No image</div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2 }}>
                {p.name}
              </span>
              {p.is_rookie === true && (
                <span className="rpc-mono" style={{ fontSize: 8, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-red)", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 4, padding: "1px 5px" }}>Rookie</span>
              )}
            </div>
            {(p.jersey_number !== null || p.position) && (
              <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", marginBottom: 6 }}>
                {p.jersey_number !== null ? `#${p.jersey_number}` : EM_DASH}{p.position ? ` · ${p.position}` : ""}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div>
                <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>EDITIONS</div>
                <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-primary)" }}>{fmtCount(p.edition_count)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>FMV</div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)" }}>{fmtUsd(p.fmv_total_usd)}</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
      {!exhausted && (
        <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
          <button type="button" className="rpc-btn-ghost" disabled={loading} onClick={loadMore}>
            {loading ? "Loading…" : `Load ${pageSize} more`}
          </button>
        </div>
      )}
    </div>
  )
}
