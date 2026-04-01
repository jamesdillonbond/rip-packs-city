"use client"

import { useEffect, useState, useMemo } from "react"

type Tag = { id: string; title: string }

type BadgeEdition = {
  id: string
  player_id: string
  player_name: string
  team: string
  team_nba_id: string
  season: string
  set_name: string
  series_number: number
  tier: string
  parallel_id: number
  parallel_name: string
  play_tags: Tag[]
  set_play_tags: Tag[]
  is_three_star_rookie: boolean
  has_rookie_mint: boolean
  badge_score: number
  low_ask: number | null
  highest_offer: number | null
  avg_sale_price: number | null
  circulation_count: number
  effective_supply: number
  burned: number
  locked: number
  owned: number
  hidden_in_packs: number
  burn_rate_pct: number
  lock_rate_pct: number
  flow_retired: boolean
  asset_path_prefix: string | null
  badge_titles: string[]
  parallel_display: string
  price_gap: number | null
  is_standard: boolean
  tier_display: string
}

type ApiResponse = {
  editions: BadgeEdition[]
  meta: {
    total: number
    limit: number
    offset: number
    mode: string
    season: string
    sort: string
    lastSync: string | null
  }
}

const MODES = [
  { value: "threestar",  label: "⭐ THREE-STAR" },
  { value: "rookieyear", label: "ROOKIE YEAR" },
  { value: "debut",      label: "TS DEBUT" },
  { value: "rookiemint", label: "ROOKIE MINT" },
  { value: "roty",       label: "ROTY" },
  { value: "blazers",    label: "🌹 BLAZERS" },
  { value: "all",        label: "ALL" },
]

const PARALLELS = [
  { value: "",   label: "All Parallels" },
  { value: "0",  label: "Standard" },
  { value: "17", label: "Blockchain" },
  { value: "18", label: "Hardcourt" },
  { value: "19", label: "Hexwave" },
  { value: "20", label: "Jukebox" },
]

const SORTS = [
  { value: "badge_score",       label: "Badge Score" },
  { value: "burn_rate_pct",     label: "Burn Rate" },
  { value: "lock_rate_pct",     label: "Lock Rate" },
  { value: "low_ask",           label: "Low Ask" },
  { value: "avg_sale_price",    label: "Avg Sale" },
  { value: "player_name",       label: "Player" },
  { value: "circulation_count", label: "Circulation" },
]

const BADGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "Rookie Year":        { bg: "rgba(224,58,47,0.12)", text: "#F87171", border: "rgba(224,58,47,0.3)" },
  "Rookie Premiere":    { bg: "rgba(255,107,53,0.12)", text: "#FB923C", border: "rgba(255,107,53,0.3)" },
  "Top Shot Debut":     { bg: "rgba(255,255,255,0.08)", text: "#F1F1F1", border: "rgba(255,255,255,0.2)" },
  "Rookie of the Year": { bg: "rgba(255,215,0,0.12)", text: "#FBBF24", border: "rgba(255,215,0,0.3)" },
  "Rookie Mint":        { bg: "rgba(59,130,246,0.12)", text: "#60A5FA", border: "rgba(59,130,246,0.3)" },
  "Championship Year":  { bg: "rgba(255,255,255,0.05)", text: "var(--rpc-text-primary)", border: "var(--rpc-border-hover)" },
}

function badgeInlineStyle(title: string): React.CSSProperties {
  const c = BADGE_COLORS[title]
  if (!c) return { background: "var(--rpc-surface-raised)", color: "var(--rpc-text-muted)", border: "1px solid var(--rpc-border)" }
  return { background: c.bg, color: c.text, border: `1px solid ${c.border}` }
}

function formatCurrency(v: number | null | undefined) {
  if (v === null || v === undefined) return "—"
  return `$${v.toFixed(2)}`
}

function formatPct(v: number | null | undefined) {
  if (v === null || v === undefined) return "—"
  return `${v.toFixed(1)}%`
}

function getImageUrl(prefix: string | null): string | null {
  if (!prefix) return null
  const resizePrefix = prefix.replace(
    "https://assets.nbatopshot.com/editions/",
    "https://assets.nbatopshot.com/resize/editions/"
  )
  return `${resizePrefix}Hero_2880_2880_Transparent.png?format=webp&quality=80&width=300`
}

function getVideoUrl(prefix: string | null): string | null {
  if (!prefix) return null
  return `${prefix}Animated_1080_1080_Black.mp4`
}

function parallelColorVar(parallelId: number): string {
  switch (parallelId) {
    case 17: return "#22D3EE"
    case 18: return "#FBBF24"
    case 19: return "#A78BFA"
    case 20: return "#F472B6"
    default: return "var(--rpc-text-muted)"
  }
}

function MomentMedia({ prefix, playerName }: { prefix: string | null; playerName: string }) {
  const [hovered, setHovered]     = useState(false)
  const [imgFailed, setImgFailed] = useState(false)
  const imgUrl   = getImageUrl(prefix)
  const videoUrl = getVideoUrl(prefix)
  const showVideo = hovered || imgFailed

  return (
    <div
      style={{ position: "relative", height: "100%", width: "100%" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {imgUrl && !imgFailed && !hovered && (
        <img
          src={imgUrl}
          alt={playerName}
          style={{ height: "100%", width: "100%", objectFit: "cover" }}
          onError={() => setImgFailed(true)}
        />
      )}
      {videoUrl && showVideo && (
        <video
          src={videoUrl}
          autoPlay
          loop
          muted
          playsInline
          style={{ height: "100%", width: "100%", objectFit: "cover" }}
        />
      )}
      {!imgUrl && !videoUrl && (
        <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
          NO MEDIA
        </div>
      )}
    </div>
  )
}

// ── Shared inline styles ────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-sm)",
  padding: "6px 10px",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-sm)",
  outline: "none",
}

const statCardStyle: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-md)",
  padding: "12px 14px",
  position: "relative",
  overflow: "hidden",
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function BadgesPage() {
  const [editions, setEditions]       = useState<BadgeEdition[]>([])
  const [meta, setMeta]               = useState<ApiResponse["meta"] | null>(null)
  const [loading, setLoading]         = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError]             = useState("")

  const [mode, setMode]         = useState("threestar")
  const [season, setSeason]     = useState("")
  const [parallel, setParallel] = useState("")
  const [sortBy, setSortBy]     = useState("badge_score")
  const [sortDir, setSortDir]   = useState<"asc" | "desc">("desc")
  const [search, setSearch]     = useState("")
  const [offset, setOffset]     = useState(0)

  const availableSeasons = useMemo(() => {
    const set = new Set<string>()
    editions.forEach(e => e.season && set.add(e.season))
    return Array.from(set).sort().reverse()
  }, [editions])

  async function fetchEditions(append = false, nextOffset = 0) {
    const params = new URLSearchParams({
      mode,
      sort:   sortBy,
      dir:    sortDir,
      limit:  "48",
      offset: String(nextOffset),
      league: "NBA",
    })
    if (season)   params.set("season", season)
    if (parallel) params.set("parallel", parallel)

    const res  = await fetch(`/api/badges?${params}`)
    const json: ApiResponse = await res.json()

    if (!res.ok) throw new Error((json as any).error || "Failed to fetch")

    setEditions(prev => append ? [...prev, ...json.editions] : json.editions)
    setMeta(json.meta)
    setOffset(nextOffset + json.editions.length)
  }

  useEffect(() => {
    setLoading(true)
    setError("")
    setOffset(0)
    fetchEditions(false, 0)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [mode, season, parallel, sortBy, sortDir])

  async function handleLoadMore() {
    setLoadingMore(true)
    try { await fetchEditions(true, offset) }
    catch (e: any) { setError(e.message) }
    finally { setLoadingMore(false) }
  }

  const filtered = useMemo(() => {
    if (!search.trim()) return editions
    const q = search.toLowerCase()
    return editions.filter(e =>
      e.player_name?.toLowerCase().includes(q) ||
      e.team?.toLowerCase().includes(q) ||
      e.set_name?.toLowerCase().includes(q) ||
      e.season?.toLowerCase().includes(q)
    )
  }, [editions, search])

  const stats = useMemo(() => ({
    total:       meta?.total ?? 0,
    avgBurnRate: filtered.length ? filtered.reduce((s, e) => s + e.burn_rate_pct, 0) / filtered.length : 0,
    avgLockRate: filtered.length ? filtered.reduce((s, e) => s + e.lock_rate_pct, 0) / filtered.length : 0,
  }), [filtered, meta])

  return (
    <div style={{ background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>

      {/* Summary stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
        {[
          { label: "TOTAL EDITIONS", value: stats.total.toLocaleString(), color: "var(--rpc-red)" },
          { label: "SHOWING", value: filtered.length.toLocaleString(), color: "var(--rpc-success)" },
          { label: "AVG BURN RATE", value: formatPct(stats.avgBurnRate), color: "var(--rpc-danger)" },
          { label: "AVG LOCK RATE", value: formatPct(stats.avgLockRate), color: "var(--rpc-success)" },
        ].map(s => (
          <div key={s.label} style={statCardStyle}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: s.color, opacity: 0.7 }} />
            <div className="rpc-label">{s.label}</div>
            <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-xl)", color: "var(--rpc-text-primary)", marginTop: 4 }}>{s.value}</div>
          </div>
        ))}
      </div>

      {/* Mode tabs */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {MODES.map(m => (
          <button
            key={m.value}
            onClick={() => { setMode(m.value); setSearch("") }}
            className={`rpc-chip ${mode === m.value ? "active" : ""}`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Filters */}
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(5, 1fr)", marginBottom: 20 }}>
        <select value={season} onChange={e => setSeason(e.target.value)} style={selectStyle}>
          <option value="">All Seasons</option>
          {availableSeasons.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select value={parallel} onChange={e => setParallel(e.target.value)} style={selectStyle}>
          {PARALLELS.map(p => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>

        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={selectStyle}>
          {SORTS.map(s => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>

        <button
          onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
          className="rpc-chip"
        >
          {sortDir === "desc" ? "↓ DESC" : "↑ ASC"}
        </button>

        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Filter by player, team, set..."
          style={{ ...selectStyle, width: "100%" }}
        />
      </div>

      {/* Sync info */}
      {meta?.lastSync && (
        <div className="rpc-mono" style={{ marginBottom: 16, color: "var(--rpc-text-ghost)" }}>
          Last synced: {new Date(meta.lastSync).toLocaleString()}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rpc-hud" style={{ marginBottom: 16, borderColor: "var(--rpc-danger)", color: "var(--rpc-danger)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
          {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rpc-card" style={{ padding: 16 }}>
              <div className="rpc-skeleton" style={{ height: 160, borderRadius: "var(--radius-md)", marginBottom: 12 }} />
              <div className="rpc-skeleton" style={{ height: 16, width: "66%", marginBottom: 8 }} />
              <div className="rpc-skeleton" style={{ height: 12, width: "50%" }} />
            </div>
          ))}
        </div>
      )}

      {/* Card grid */}
      {!loading && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map(e => {
            const playId = e.id.split("+")[1]
            const visibleBadges = [
              ...e.play_tags.filter(t =>
                ["Rookie Year", "Rookie Premiere", "Top Shot Debut", "Rookie of the Year", "Championship Year"].includes(t.title)
              ),
              ...e.set_play_tags.filter(t => t.title === "Rookie Mint"),
            ]

            return (
              <div
                key={e.id}
                className={`rpc-card ${e.tier.toUpperCase() === "LEGENDARY" ? "rpc-holo-legendary" : e.tier.toUpperCase() === "ULTIMATE" ? "rpc-holo-ultimate" : e.tier.toUpperCase() === "RARE" ? "rpc-holo-rare" : ""}`}
                style={{ overflow: "hidden", transition: "border-color var(--transition-fast)" }}
              >
                {/* Moment media */}
                <div style={{ position: "relative", aspectRatio: "1", overflow: "hidden", background: "var(--rpc-surface)" }}>
                  <MomentMedia
                    prefix={e.asset_path_prefix}
                    playerName={e.player_name}
                  />

                  {/* Parallel badge top-right */}
                  {e.parallel_id !== 0 && (
                    <div style={{ position: "absolute", right: 8, top: 8, borderRadius: 999, border: "1px solid currentColor", background: "rgba(0,0,0,0.8)", padding: "2px 8px", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", fontWeight: 700, color: parallelColorVar(e.parallel_id) }}>
                      {e.parallel_display}
                    </div>
                  )}

                  {/* Badge score top-left */}
                  {e.badge_score >= 8 && (
                    <div style={{ position: "absolute", left: 8, top: 8, width: 28, height: 28, borderRadius: "50%", background: "var(--rpc-red)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontFamily: "var(--font-display)", fontWeight: 900, color: "#fff", boxShadow: "var(--shadow-glow-red)" }}>
                      {e.badge_score}
                    </div>
                  )}

                  {/* Three-star indicator */}
                  {e.is_three_star_rookie && e.has_rookie_mint && (
                    <div style={{ position: "absolute", bottom: 8, left: 8, borderRadius: 999, background: "rgba(0,0,0,0.8)", padding: "2px 8px", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", fontWeight: 700, color: "var(--tier-legendary)" }}>
                      ⭐ 3-STAR
                    </div>
                  )}
                </div>

                {/* Card body */}
                <div style={{ padding: 12 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", lineHeight: 1.2, marginBottom: 2 }}>
                    {e.player_name}
                  </div>
                  <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", marginBottom: 6 }}>
                    {e.team} · {e.season}
                  </div>
                  <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", marginBottom: 8 }}>
                    {e.set_name} · S{e.series_number}
                  </div>

                  {/* Badges */}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                    {visibleBadges.map(t => (
                      <span
                        key={t.id}
                        style={{ ...badgeInlineStyle(t.title), borderRadius: 3, padding: "2px 6px", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", fontWeight: 600, letterSpacing: "0.06em" }}
                      >
                        {t.title}
                      </span>
                    ))}
                  </div>

                  {/* Stats grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, textAlign: "center" }}>
                    <div style={{ background: "var(--rpc-surface-raised)", borderRadius: "var(--radius-sm)", padding: "6px 4px" }}>
                      <div className="rpc-label">ASK</div>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-sm)", color: "var(--rpc-text-primary)", marginTop: 2 }}>{formatCurrency(e.low_ask)}</div>
                    </div>
                    <div style={{ background: "var(--rpc-surface-raised)", borderRadius: "var(--radius-sm)", padding: "6px 4px" }}>
                      <div className="rpc-label">BURNED</div>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-sm)", color: e.burn_rate_pct > 15 ? "var(--rpc-danger)" : "var(--rpc-text-primary)", marginTop: 2 }}>
                        {formatPct(e.burn_rate_pct)}
                      </div>
                    </div>
                    <div style={{ background: "var(--rpc-surface-raised)", borderRadius: "var(--radius-sm)", padding: "6px 4px" }}>
                      <div className="rpc-label">LOCKED</div>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-sm)", color: e.lock_rate_pct > 40 ? "var(--rpc-success)" : "var(--rpc-text-primary)", marginTop: 2 }}>
                        {formatPct(e.lock_rate_pct)}
                      </div>
                    </div>
                  </div>

                  {/* Supply burn bar */}
                  <div style={{ marginTop: 10 }}>
                    <div className="rpc-mono" style={{ display: "flex", justifyContent: "space-between", color: "var(--rpc-text-ghost)", marginBottom: 4 }}>
                      <span>Circ {e.effective_supply.toLocaleString()}</span>
                      <span>{e.burned.toLocaleString()} burned</span>
                    </div>
                    <div style={{ height: 3, width: "100%", overflow: "hidden", borderRadius: 999, background: "var(--rpc-surface-raised)" }}>
                      <div
                        style={{ height: "100%", borderRadius: 999, background: "var(--rpc-red)", width: `${Math.min(e.burn_rate_pct, 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* Marketplace link */}
                  <a
                    href={`https://nbatopshot.com/listings/moment/${playId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rpc-btn-ghost"
                    style={{ display: "block", textAlign: "center", marginTop: 10, textDecoration: "none", fontSize: "var(--text-xs)" }}
                  >
                    VIEW ON TOP SHOT ↗
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Load more */}
      {!loading && meta && offset < meta.total && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 32 }}>
          <button
            onClick={handleLoadMore}
            disabled={loadingMore}
            className="rpc-btn-primary"
            style={{ opacity: loadingMore ? 0.5 : 1, padding: "10px 24px" }}
          >
            {loadingMore ? "LOADING..." : `LOAD MORE (${meta.total - offset} REMAINING)`}
          </button>
        </div>
      )}

      {/* Empty state */}
      {!loading && filtered.length === 0 && !error && (
        <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
          <span style={{ fontSize: 40, opacity: 0.3 }}>⭐</span>
          <p className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>NO BADGES FOUND</p>
          <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)" }}>This wallet doesn&apos;t have any badge-eligible moments.</p>
        </div>
      )}

    </div>
  )
}
