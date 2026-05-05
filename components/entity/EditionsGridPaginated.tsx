"use client"

// components/entity/EditionsGridPaginated.tsx
// Phase 1C/1D/1F. Reusable paginated edition tile grid used by Set, Player,
// and Series pages. Each tile links to /[collection]/edition/[route_slug].
// "Load more" calls the supplied endpoint with offset.

import { useState } from "react"
import Link from "next/link"
import { ConfidencePill, EM_DASH, TierBadge, fmtCount, fmtUsd } from "./_shared"

export interface EditionTile {
  route_slug: string
  player_name: string | null
  player_slug?: string | null
  name: string | null
  set_name?: string | null
  set_slug?: string | null
  tier: string | null
  tier_rank?: number | null
  series_label: string | null
  series_num?: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  team_name?: string | null
  fmv_usd: number | null
  floor_usd?: number | null
  fmv_confidence?: string | null
  fmv_computed_at?: string | null
}

type SortKey = "fmv_desc" | "circ_asc" | "series_desc" | "alpha"

interface Props {
  collectionUrlSlug: string
  /** Endpoint to call for offset-based pagination. Endpoint must echo back an array of EditionTile. */
  fetchUrl: string
  initial: EditionTile[]
  pageSize: number
  showSetLink?: boolean
  showSort?: boolean
}

function compare(a: EditionTile, b: EditionTile, key: SortKey): number {
  const av = a.fmv_usd ?? 0
  const bv = b.fmv_usd ?? 0
  switch (key) {
    case "fmv_desc": return bv - av
    case "circ_asc": return (a.circulation_count ?? 1e12) - (b.circulation_count ?? 1e12)
    case "series_desc": return (b.series_num ?? 0) - (a.series_num ?? 0)
    case "alpha": return (a.player_name ?? a.name ?? "").localeCompare(b.player_name ?? b.name ?? "")
  }
}

export default function EditionsGridPaginated({ collectionUrlSlug, fetchUrl, initial, pageSize, showSetLink = true, showSort = false }: Props) {
  const [rows, setRows] = useState<EditionTile[]>(initial)
  const [offset, setOffset] = useState<number>(initial.length)
  const [loading, setLoading] = useState(false)
  const [exhausted, setExhausted] = useState(initial.length < pageSize)
  const [sortKey, setSortKey] = useState<SortKey>("fmv_desc")

  const sorted = showSort ? [...rows].sort((a, b) => compare(a, b, sortKey)) : rows

  async function loadMore() {
    if (loading || exhausted) return
    setLoading(true)
    try {
      const sep = fetchUrl.includes("?") ? "&" : "?"
      const url = `${fetchUrl}${sep}offset=${offset}&limit=${pageSize}`
      const r = await fetch(url, { cache: "no-store" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const next: EditionTile[] = await r.json()
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
    return <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "'Share Tech Mono', monospace", fontSize: 12 }}>No editions yet.</div>
  }

  return (
    <div>
      {showSort && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {([
            { k: "fmv_desc",    l: "FMV ↓" },
            { k: "circ_asc",    l: "Mint ↑" },
            { k: "series_desc", l: "Series ↓" },
            { k: "alpha",       l: "A → Z" },
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
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
        {sorted.map(e => (
          <Link
            key={e.route_slug}
            href={`/${collectionUrlSlug}/edition/${encodeURIComponent(e.route_slug)}`}
            className="rpc-card"
            style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block" }}
          >
            <div style={{ aspectRatio: "1 / 1", background: "rgba(0,0,0,0.35)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
              {e.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={e.thumbnail_url} alt={e.player_name ?? e.name ?? "Edition"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "'Share Tech Mono', monospace", fontSize: 10 }}>No image</div>
              )}
            </div>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
              {e.player_name ?? e.name ?? "Edition"}
            </div>
            {showSetLink && e.set_name && (
              <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", marginBottom: 6 }}>{e.set_name}</div>
            )}
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
              <TierBadge tier={e.tier} />
              {e.series_label && <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{e.series_label}</span>}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div>
                <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>FMV</div>
                <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 16, color: "var(--rpc-text-primary)" }}>{fmtUsd(e.fmv_usd)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>Floor</div>
                <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>{fmtUsd(e.floor_usd ?? null)}</div>
              </div>
            </div>
            <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <ConfidencePill confidence={e.fmv_confidence ?? null} />
              {e.circulation_count !== null && e.circulation_count !== undefined && (
                <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
                  Mint {fmtCount(e.circulation_count)}
                </span>
              )}
              {(e.circulation_count === null || e.circulation_count === undefined) && (
                <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>Mint {EM_DASH}</span>
              )}
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
