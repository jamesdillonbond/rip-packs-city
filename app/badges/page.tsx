"use client"

import { useEffect, useState, useMemo } from "react"

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Constants ─────────────────────────────────────────────────────────────────

const MODES = [
  { value: "threestar",  label: "⭐ Three-Star" },
  { value: "rookieyear", label: "Rookie Year" },
  { value: "debut",      label: "TS Debut" },
  { value: "rookiemint", label: "Rookie Mint" },
  { value: "roty",       label: "ROTY" },
  { value: "blazers",    label: "🌹 Blazers" },
  { value: "all",        label: "All" },
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
  "Top Shot Debut":     "bg-zinc-100 text-black border border-zinc-300",
  "Rookie of the Year": "bg-yellow-950 text-yellow-300 border border-yellow-700",
  "Rookie Mint":        "bg-blue-950 text-blue-300 border border-blue-800",
  "Championship Year":  "bg-zinc-800 text-white border border-zinc-600",
}

function badgeStyle(title: string) {
  return BADGE_COLORS[title] ?? "bg-zinc-800 text-zinc-300 border border-zinc-700"
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

function parallelColor(parallelId: number) {
  switch (parallelId) {
    case 17: return "text-cyan-400"
    case 18: return "text-amber-400"
    case 19: return "text-purple-400"
    case 20: return "text-pink-400"
    default: return "text-zinc-400"
  }
}

// ── Moment media component — static image, plays video on hover ───────────────

function MomentMedia({ prefix, playerName }: { prefix: string | null; playerName: string }) {
  const [hovered, setHovered]   = useState(false)
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
        <div className="flex h-full items-center justify-center text-zinc-700 text-xs">
          No media
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

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
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">

        {/* ── Header ── */}
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img
            src="/rip-packs-city-logo.png"
            alt="Rip Packs City"
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 9999 }}
          />
          <div className="flex-1">
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">
              RIP PACKS CITY
            </h1>
            <p className="text-xs text-zinc-400 md:text-sm">
              Badge Tracker — Rookie edition intelligence
            </p>
          </div>
          <a
            href="/wallet"
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900"
          >
            ← Wallet
          </a>
        </div>

        {/* ── Summary stats ── */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { label: "Total Editions", value: stats.total.toLocaleString() },
            { label: "Showing",        value: filtered.length.toLocaleString() },
            { label: "Avg Burn Rate",  value: formatPct(stats.avgBurnRate) },
            { label: "Avg Lock Rate",  value: formatPct(stats.avgLockRate) },
          ].map(s => (
            <div key={s.label} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{s.label}</div>
              <div className="text-lg font-bold text-white">{s.value}</div>
            </div>
          ))}
        </div>

        {/* ── Mode tabs ── */}
        <div className="mb-4 flex flex-wrap gap-2">
          {MODES.map(m => (
            <button
              key={m.value}
              onClick={() => { setMode(m.value); setSearch("") }}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                mode === m.value
                  ? "bg-red-600 text-white"
                  : "border border-zinc-700 text-zinc-300 hover:bg-zinc-900"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {/* ── Filters ── */}
        <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <select
            value={season}
            onChange={e => setSeason(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white"
          >
            <option value="">All Seasons</option>
            {availableSeasons.map(s => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select
            value={parallel}
            onChange={e => setParallel(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white"
          >
            {PARALLELS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white"
          >
            {SORTS.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>

          <button
            onClick={() => setSortDir(d => d === "desc" ? "asc" : "desc")}
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white hover:bg-zinc-900"
          >
            {sortDir === "desc" ? "↓ Desc" : "↑ Asc"}
          </button>

          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Filter by player, team, set..."
            className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-white placeholder:text-zinc-500 focus:border-red-600 outline-none"
          />
        </div>

        {/* ── Sync info ── */}
        {meta?.lastSync && (
          <div className="mb-4 text-xs text-zinc-500">
            Last synced: {new Date(meta.lastSync).toLocaleString()}
            {" · "}
            <span className="text-zinc-400">
              Run <code className="rounded bg-zinc-900 px-1 py-0.5">scripts/topshot-badge-sync.js</code> in the Top Shot console to refresh
            </span>
          </div>
        )}

        {/* ── Error ── */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300">
            {error}
          </div>
        )}

        {/* ── Loading skeleton ── */}
        {loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="animate-pulse rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 h-40 rounded-lg bg-zinc-800" />
                <div className="mb-2 h-4 w-2/3 rounded bg-zinc-800" />
                <div className="h-3 w-1/2 rounded bg-zinc-800" />
              </div>
            ))}
          </div>
        )}

        {/* ── Card grid ── */}
        {!loading && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map(e => {
              const visibleBadges = [
                ...e.play_tags.filter(t =>
                  ["Rookie Year", "Rookie Premiere", "Top Shot Debut", "Rookie of the Year", "Championship Year"].includes(t.title)
                ),
                ...e.set_play_tags.filter(t => t.title === "Rookie Mint"),
              ]

              return (
                <div
                  key={e.id}
                  className="group relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 transition hover:border-zinc-600"
                >
                  {/* Moment media */}
                  <div className="relative aspect-square overflow-hidden bg-zinc-900">
                    <MomentMedia
                      prefix={e.asset_path_prefix}
                      playerName={e.player_name}
                    />

                    {/* Parallel badge top-right */}
                    {e.parallel_id !== 0 && (
                      <div className={`absolute right-2 top-2 rounded-full border border-current bg-black/80 px-2 py-0.5 text-[10px] font-bold ${parallelColor(e.parallel_id)}`}>
                        {e.parallel_display}
                      </div>
                    )}

                    {/* Badge score top-left */}
                    {e.badge_score >= 8 && (
                      <div className="absolute left-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-red-600 text-[11px] font-black text-white shadow">
                        {e.badge_score}
                      </div>
                    )}

                    {/* Three-star indicator bottom-left */}
                    {e.is_three_star_rookie && e.has_rookie_mint && (
                      <div className="absolute bottom-2 left-2 rounded-full bg-black/80 px-2 py-0.5 text-[10px] font-bold text-yellow-400">
                        ⭐ 3-Star
                      </div>
                    )}
                  </div>

                  {/* Card body */}
                  <div className="p-3">
                    <div className="mb-0.5 font-semibold text-white leading-tight">
                      {e.player_name}
                    </div>
                    <div className="mb-2 text-xs text-zinc-400">
                      {e.team} · {e.season}
                    </div>
                    <div className="mb-2 text-xs text-zinc-500">
                      {e.set_name} · Series {e.series_number}
                    </div>

                    {/* Badges */}
                    <div className="mb-3 flex flex-wrap gap-1">
                      {visibleBadges.map(t => (
                        <span
                          key={t.id}
                          className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${badgeStyle(t.title)}`}
                        >
                          {t.title}
                        </span>
                      ))}
                    </div>

                    {/* Stats grid */}
                    <div className="grid grid-cols-3 gap-1.5 text-center">
                      <div className="rounded-lg bg-black/60 px-1.5 py-1.5">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Ask</div>
                        <div className="text-sm font-bold text-white">{formatCurrency(e.low_ask)}</div>
                      </div>
                      <div className="rounded-lg bg-black/60 px-1.5 py-1.5">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Burned</div>
                        <div className={`text-sm font-bold ${e.burn_rate_pct > 15 ? "text-red-400" : "text-white"}`}>
                          {formatPct(e.burn_rate_pct)}
                        </div>
                      </div>
                      <div className="rounded-lg bg-black/60 px-1.5 py-1.5">
                        <div className="text-[10px] text-zinc-500 uppercase tracking-wide">Locked</div>
                        <div className={`text-sm font-bold ${e.lock_rate_pct > 40 ? "text-emerald-400" : "text-white"}`}>
                          {formatPct(e.lock_rate_pct)}
                        </div>
                      </div>
                    </div>

                    {/* Supply burn bar */}
                    <div className="mt-3">
                      <div className="mb-1 flex justify-between text-[10px] text-zinc-500">
                        <span>Circ {e.effective_supply.toLocaleString()}</span>
                        <span>{e.burned.toLocaleString()} burned</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800">
                        <div
                          className="h-full rounded-full bg-red-600"
                          style={{ width: `${Math.min(e.burn_rate_pct, 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* Marketplace link */}
                    <a
                      href={`https://nbatopshot.com/marketplace?filters=badges&playID=${e.id.split("+")[1]}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-3 block rounded-lg border border-zinc-700 py-1.5 text-center text-xs text-zinc-300 transition hover:border-red-600 hover:text-white"
                    >
                      View on Top Shot ↗
                    </a>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Load more ── */}
        {!loading && meta && offset < meta.total && (
          <div className="mt-8 flex justify-center">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="rounded-lg bg-red-600 px-6 py-2 font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
            >
              {loadingMore ? "Loading..." : `Load More (${meta.total - offset} remaining)`}
            </button>
          </div>
        )}

        {/* ── Empty state ── */}
        {!loading && filtered.length === 0 && !error && (
          <div className="py-20 text-center text-zinc-500">
            No badge editions found for this filter combination.
          </div>
        )}

      </div>
    </div>
  )
}