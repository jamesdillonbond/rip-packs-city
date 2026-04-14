"use client"

import { useEffect, useState, useMemo } from "react"
import { useParams } from "next/navigation"
import { ALLDAY_BADGE_COLORS } from "@/lib/allday-badges"

const COLLECTION_UUID_BY_SLUG: Record<string, string> = {
  "nba-top-shot": "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  "nfl-all-day": "dee28451-5d62-409e-a1ad-a83f763ac070",
}
const ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR = new Set(["Rookie Year", "Rookie Premiere", "Rookie Mint"])

const ALLDAY_MODES = [
  { value: "all",           label: "All" },
  { value: "rookie_ad",     label: "Rookie" },
  { value: "superbowl_ad",  label: "Super Bowl" },
  { value: "playoffs_ad",   label: "Playoffs" },
  { value: "probowl_ad",    label: "Pro Bowl" },
  { value: "firsttd_ad",    label: "First TD" },
]

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
  { value: "threestar",    label: "Three-Star" },
  { value: "rookieyear",   label: "Rookie Year" },
  { value: "debut",        label: "TS Debut" },
  { value: "rookiemint",   label: "Rookie Mint" },
  { value: "roty",         label: "ROTY" },
  { value: "championship", label: "Champ Year" },
  { value: "blazers",      label: "Blazers" },
  { value: "all",          label: "All" },
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

const BADGE_COLORS: Record<string, string> = {
  "Rookie Year":        "bg-red-950 text-red-300 border border-red-800",
  "Rookie Premiere":    "bg-orange-950 text-orange-300 border border-orange-800",
  "Top Shot Debut":     "border border-white/20 text-white/90 bg-white/5",
  "Rookie of the Year": "bg-yellow-950 text-yellow-300 border border-yellow-700",
  "Rookie Mint":        "bg-blue-950 text-blue-300 border border-blue-800",
  "Championship Year":  "border border-white/10 text-white/70 bg-white/3",
}

function badgeStyle(title: string) {
  return BADGE_COLORS[title] ?? "border border-white/10 text-white/50 bg-white/3"
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

function parallelColor(parallelId: number): string {
  switch (parallelId) {
    case 17: return "#22d3ee"
    case 18: return "#fbbf24"
    case 19: return "#a855f7"
    case 20: return "#ec4899"
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
      className="relative h-full w-full"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {imgUrl && !imgFailed && !hovered && (
        <img
          src={imgUrl}
          alt={playerName}
          className="h-full w-full object-cover"
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
          className="h-full w-full object-cover"
        />
      )}
      {!imgUrl && !videoUrl && (
        <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
          No media
        </div>
      )}
    </div>
  )
}

export default function BadgesPage() {
  const routeParams = useParams()
  const collectionSlug = (routeParams?.collection as string) ?? "nba-top-shot"
  const isAllDay = collectionSlug === "nfl-all-day"
  const collectionId = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? COLLECTION_UUID_BY_SLUG["nba-top-shot"]
  const MODES_FOR_COLLECTION = isAllDay ? ALLDAY_MODES : MODES
  const [editions, setEditions]       = useState<BadgeEdition[]>([])
  const [meta, setMeta]               = useState<ApiResponse["meta"] | null>(null)
  const [loading, setLoading]         = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError]             = useState("")

  const [mode, setMode]         = useState(isAllDay ? "all" : "threestar")
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
      collection_id: collectionId,
    })
    if (!isAllDay) params.set("league", "NBA")
    if (season)   params.set("season", season)
    if (parallel && !isAllDay) params.set("parallel", parallel)

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

  const statColors = ["var(--rpc-red)", "var(--rpc-info)", "var(--rpc-danger)", "var(--rpc-success)"]

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <div style={{ maxWidth: 1600, margin: "0 auto", padding: "16px 12px" }}>

        {/* Summary stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginBottom: 20 }}>
          {[
            { label: "Total Editions", value: stats.total.toLocaleString() },
            { label: "Showing",        value: filtered.length.toLocaleString() },
            { label: "Avg Burn Rate",  value: formatPct(stats.avgBurnRate) },
            { label: "Avg Lock Rate",  value: formatPct(stats.avgLockRate) },
          ].map((s, i) => (
            <div key={s.label} style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              borderTop: `2px solid ${statColors[i]}`,
              padding: 12,
            }}>
              <div style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: "0.15em",
                textTransform: "uppercase" as const,
                color: "var(--rpc-text-muted)",
                marginBottom: 4,
              }}>{s.label}</div>
              <div style={{
                fontFamily: "var(--font-display)",
                fontWeight: 800,
                fontSize: 20,
                color: "var(--rpc-text-primary)",
              }}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Mode tabs */}
        <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8, marginBottom: 16 }}>
          {MODES_FOR_COLLECTION.map(m => (
            <button
              key={m.value}
              onClick={() => { setMode(m.value); setSearch("") }}
              className={mode === m.value ? "rpc-chip active" : "rpc-chip"}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* Filters */}
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", marginBottom: 20 }}>
          <select
            value={season}
            onChange={e => setSeason(e.target.value)}
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              padding: "8px 12px",
              color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            <option value="">All Seasons</option>
            {availableSeasons.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          {!isAllDay && (
            <select
              value={parallel}
              onChange={e => setParallel(e.target.value)}
              style={{
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: "var(--radius-md)",
                padding: "8px 12px",
                color: "var(--rpc-text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
              }}
            >
              {PARALLELS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          )}

          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              padding: "8px 12px",
              color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
            }}
          >
            {SORTS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          <button
            onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
            className="rpc-chip"
            style={{ justifyContent: "center" }}
          >
            {sortDir === "desc" ? "DESC" : "ASC"}
          </button>

          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by player, team, set..."
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              padding: "8px 12px",
              color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              outline: "none",
            }}
          />
        </div>

        {/* Sync info */}
        {meta?.lastSync && (
          <div style={{ marginBottom: 16, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
            Last synced: {new Date(meta.lastSync).toLocaleString()}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rpc-alert" style={{ marginBottom: 16 }}>
            {error}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
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
          <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {filtered.map(e => {
              const playId = e.id.split("+")[1]
              const rawBadges = isAllDay
                ? e.set_play_tags
                : [
                    ...e.play_tags.filter(t =>
                      ["Rookie Year", "Rookie Premiere", "Top Shot Debut", "Rookie of the Year", "Championship Year"].includes(t.title)
                    ),
                    ...e.set_play_tags.filter(t => t.title === "Rookie Mint"),
                  ]
              const visibleBadges = (e.is_three_star_rookie && !isAllDay)
                ? rawBadges.filter(t => !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t.title))
                : rawBadges
              const tierUpper = e.tier.toUpperCase()
              const holoClass = tierUpper === "LEGENDARY" ? "rpc-holo-legendary"
                : tierUpper === "ULTIMATE" ? "rpc-holo-ultimate"
                : tierUpper === "RARE" ? "rpc-holo-rare"
                : ""

              return (
                <div
                  key={e.id}
                  className={`rpc-card group ${holoClass}`}
                  style={{ overflow: "hidden", position: "relative" }}
                >
                  {/* Moment media */}
                  <div style={{ position: "relative", aspectRatio: "1", overflow: "hidden", background: "var(--rpc-surface)" }}>
                    <MomentMedia
                      prefix={e.asset_path_prefix}
                      playerName={e.player_name}
                    />

                    {/* Parallel badge top-right */}
                    {e.parallel_id !== 0 && (
                      <div style={{
                        position: "absolute", right: 8, top: 8,
                        borderRadius: 9999, border: "1px solid currentColor",
                        background: "rgba(0,0,0,0.8)", padding: "2px 8px",
                        fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
                        color: parallelColor(e.parallel_id),
                      }}>
                        {e.parallel_display}
                      </div>
                    )}

                    {/* Badge score top-left */}
                    {e.badge_score >= 8 && (
                      <div style={{
                        position: "absolute", left: 8, top: 8,
                        width: 28, height: 28, borderRadius: 9999,
                        background: "var(--rpc-red)", display: "flex",
                        alignItems: "center", justifyContent: "center",
                        fontFamily: "var(--font-display)", fontSize: 11,
                        fontWeight: 900, color: "#fff",
                      }}>
                        {e.badge_score}
                      </div>
                    )}

                    {/* Three-star indicator */}
                    {e.is_three_star_rookie && e.has_rookie_mint && (
                      <div style={{
                        position: "absolute", bottom: 8, left: 8,
                        borderRadius: 9999, background: "rgba(0,0,0,0.8)",
                        padding: "2px 8px", fontFamily: "var(--font-mono)",
                        fontSize: 10, fontWeight: 700, color: "#fbbf24",
                      }}>
                        3-STAR
                      </div>
                    )}
                  </div>

                  {/* Card body */}
                  <div style={{ padding: 12 }}>
                    <div style={{
                      fontFamily: "var(--font-display)", fontWeight: 800,
                      color: "var(--rpc-text-primary)", lineHeight: 1.2,
                      marginBottom: 2,
                    }}>
                      {e.player_name}
                    </div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 11,
                      color: "var(--rpc-text-secondary)", marginBottom: 8,
                    }}>
                      {e.team} &middot; {e.season}
                    </div>
                    <div style={{
                      fontFamily: "var(--font-mono)", fontSize: 11,
                      color: "var(--rpc-text-muted)", marginBottom: 8,
                    }}>
                      {e.set_name} &middot; Series {e.series_number}
                    </div>

                    {/* Badges */}
                    <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, marginBottom: 12 }}>
                      {visibleBadges.map(t => {
                        const cls = isAllDay
                          ? (ALLDAY_BADGE_COLORS[t.title] ?? "border border-white/10 text-white/50 bg-white/3")
                          : badgeStyle(t.title)
                        return (
                          <span
                            key={t.id}
                            className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${cls}`}
                            style={{ fontFamily: "var(--font-mono)" }}
                          >
                            {t.title}
                          </span>
                        )
                      })}
                    </div>

                    {/* Stats grid */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, textAlign: "center" }}>
                      {[
                        { label: "ASK", value: formatCurrency(e.low_ask), highlight: false },
                        { label: "BURNED", value: formatPct(e.burn_rate_pct), highlight: e.burn_rate_pct > 15 },
                        { label: "LOCKED", value: formatPct(e.lock_rate_pct), highlight: e.lock_rate_pct > 40 },
                      ].map(stat => (
                        <div key={stat.label} style={{
                          background: "var(--rpc-surface)",
                          borderRadius: "var(--radius-md)",
                          padding: "6px 4px",
                        }}>
                          <div style={{
                            fontFamily: "var(--font-mono)", fontSize: 9,
                            letterSpacing: "0.15em", textTransform: "uppercase" as const,
                            color: "var(--rpc-text-muted)", marginBottom: 2,
                          }}>{stat.label}</div>
                          <div style={{
                            fontFamily: "var(--font-display)", fontWeight: 800,
                            fontSize: 14,
                            color: stat.label === "BURNED" && stat.highlight ? "var(--rpc-danger)"
                              : stat.label === "LOCKED" && stat.highlight ? "var(--rpc-success)"
                              : "var(--rpc-text-primary)",
                          }}>{stat.value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Supply burn bar */}
                    <div style={{ marginTop: 12 }}>
                      <div style={{
                        display: "flex", justifyContent: "space-between",
                        fontFamily: "var(--font-mono)", fontSize: 10,
                        color: "var(--rpc-text-muted)", marginBottom: 4,
                      }}>
                        <span>Circ {e.effective_supply.toLocaleString()}</span>
                        <span>{e.burned.toLocaleString()} burned</span>
                      </div>
                      <div style={{
                        height: 3, width: "100%", overflow: "hidden",
                        borderRadius: 9999, background: "var(--rpc-border)",
                      }}>
                        <div style={{
                          height: "100%", borderRadius: 9999,
                          background: "var(--rpc-red)",
                          width: `${Math.min(e.burn_rate_pct, 100)}%`,
                        }} />
                      </div>
                    </div>

                    {/* Marketplace link */}
                    <a
                      href={`https://nbatopshot.com/listings/moment/${playId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="rpc-btn-outline"
                      style={{
                        display: "block", marginTop: 12,
                        textAlign: "center", fontSize: 12,
                        padding: "6px 0",
                      }}
                    >
                      VIEW ON TOP SHOT
                    </a>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* Load more */}
        {!loading && meta && offset < meta.total && (
          <div style={{ marginTop: 32, display: "flex", justifyContent: "center" }}>
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="rpc-btn-primary"
              style={{ opacity: loadingMore ? 0.5 : 1 }}
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
    </div>
  )
}
