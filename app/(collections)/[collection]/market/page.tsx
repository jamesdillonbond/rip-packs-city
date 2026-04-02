"use client"

import { useEffect, useState, useMemo, useCallback, useRef, Suspense } from "react"
import { useSearchParams, useRouter } from "next/navigation"
import { getOwnerKey, onOwnerKeyChange } from "@/lib/owner-key"

// ── Types ──────────────────────────────────────────────────────────────────────

type BadgeEdition = {
  id: string
  player_name: string
  team: string
  team_nba_id: string
  season: string
  set_name: string
  series_number: number
  tier: string
  parallel_id: number
  parallel_display: string
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
  burn_rate_pct: number
  lock_rate_pct: number
  flow_retired: boolean
  asset_path_prefix: string | null
  badge_titles: string[]
  price_gap: number | null
  is_standard: boolean
  tier_display: string
}

type FlowtyListing = {
  listingResourceID: string
  storefrontAddress: string
  salePrice: number
  serial: number
}

type Meta = {
  total: number
  limit: number
  offset: number
}

// ── Constants ──────────────────────────────────────────────────────────────────

const SERIES_LABELS: Record<number, string> = {
  0: "Beta", 1: "S1", 2: "S2", 3: "S3", 4: "S4",
  5: "S5", 6: "S6", 7: "S7", 8: "S8",
}

const BADGE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "Rookie Year":        { bg: "rgba(220,38,38,0.15)",  text: "#fca5a5", border: "rgba(220,38,38,0.35)" },
  "Rookie Premiere":    { bg: "rgba(234,88,12,0.15)",  text: "#fdba74", border: "rgba(234,88,12,0.35)" },
  "Top Shot Debut":     { bg: "rgba(255,255,255,0.07)", text: "rgba(255,255,255,0.85)", border: "rgba(255,255,255,0.18)" },
  "Rookie of the Year": { bg: "rgba(202,138,4,0.15)",  text: "#fde68a", border: "rgba(202,138,4,0.35)" },
  "Rookie Mint":        { bg: "rgba(37,99,235,0.15)",  text: "#93c5fd", border: "rgba(37,99,235,0.35)" },
  "Championship Year":  { bg: "rgba(255,255,255,0.04)", text: "rgba(255,255,255,0.55)", border: "rgba(255,255,255,0.12)" },
}

const TIER_ORDER = ["COMMON", "FANDOM", "RARE", "LEGENDARY", "ULTIMATE"]

const TIER_COLORS: Record<string, string> = {
  COMMON: "var(--rpc-text-muted)",
  FANDOM: "var(--rpc-info)",
  RARE: "var(--tier-rare)",
  LEGENDARY: "var(--tier-legendary)",
  ULTIMATE: "var(--tier-ultimate, #ff4ecd)",
}

const PAGE_SIZE = 50

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(v: number | null | undefined, prefix = "$"): string {
  if (v == null) return "—"
  return `${prefix}${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return "—"
  return `${v.toFixed(1)}%`
}

function seriesLabel(n: number): string {
  return SERIES_LABELS[n] ?? `S${n}`
}

function tierColor(tier: string): string {
  return TIER_COLORS[tier.toUpperCase().replace("MOMENT_TIER_", "")] ?? "var(--rpc-text-muted)"
}

function parallelColor(id: number): string {
  switch (id) {
    case 17: return "#22d3ee"
    case 18: return "#fbbf24"
    case 19: return "#a855f7"
    case 20: return "#ec4899"
    default: return "var(--rpc-text-muted)"
  }
}

function getImageUrl(prefix: string | null): string | null {
  if (!prefix) return null
  const r = prefix.replace(
    "https://assets.nbatopshot.com/editions/",
    "https://assets.nbatopshot.com/resize/editions/"
  )
  return `${r}Hero_2880_2880_Transparent.png?format=webp&quality=80&width=300`
}

function getVideoUrl(prefix: string | null): string | null {
  if (!prefix) return null
  return `${prefix}Animated_1080_1080_Black.mp4`
}

function holoClass(tier: string): string {
  const t = tier.toUpperCase().replace("MOMENT_TIER_", "")
  if (t === "LEGENDARY") return "rpc-holo-legendary"
  if (t === "ULTIMATE") return "rpc-holo-ultimate"
  if (t === "RARE") return "rpc-holo-rare"
  return ""
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function MomentThumb({ prefix, playerName, size = 36 }: {
  prefix: string | null; playerName: string; size?: number
}) {
  const [failed, setFailed] = useState(false)
  const imgUrl = getImageUrl(prefix)
  if (!imgUrl || failed) {
    return (
      <div style={{
        width: size, height: size, borderRadius: 6, background: "var(--rpc-surface-raised)",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--rpc-text-ghost)",
      }}>
        ?
      </div>
    )
  }
  return (
    <img
      src={imgUrl}
      alt={playerName}
      width={size}
      height={size}
      style={{ borderRadius: 6, objectFit: "cover", flexShrink: 0 }}
      onError={() => setFailed(true)}
    />
  )
}

function BadgePill({ title }: { title: string }) {
  const style = BADGE_COLORS[title] ?? {
    bg: "rgba(255,255,255,0.04)", text: "rgba(255,255,255,0.5)", border: "rgba(255,255,255,0.1)"
  }
  const abbr: Record<string, string> = {
    "Rookie Year": "RY",
    "Rookie Premiere": "RP",
    "Top Shot Debut": "TSD",
    "Rookie of the Year": "ROTY",
    "Rookie Mint": "RM",
    "Championship Year": "CY",
  }
  return (
    <span style={{
      display: "inline-flex", alignItems: "center",
      padding: "1px 6px", borderRadius: 4,
      background: style.bg, color: style.text,
      border: `1px solid ${style.border}`,
      fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
      letterSpacing: "0.03em", whiteSpace: "nowrap",
    }}>
      {abbr[title] ?? title}
    </span>
  )
}

function FilterToggle({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "4px 12px", borderRadius: 6, cursor: "pointer",
        fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
        letterSpacing: "0.05em", transition: "all 0.15s",
        background: active ? "var(--rpc-red)" : "var(--rpc-surface-raised)",
        color: active ? "#fff" : "var(--rpc-text-muted)",
        border: active ? "1px solid var(--rpc-red)" : "1px solid var(--rpc-border)",
      }}
    >
      {label}
    </button>
  )
}

// ── Listings Modal ─────────────────────────────────────────────────────────────

function ListingsModal({
  edition,
  ownedSerials,
  onClose,
}: {
  edition: BadgeEdition
  ownedSerials: Set<number>
  onClose: () => void
}) {
  const [listings, setListings] = useState<FlowtyListing[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hovered, setHovered] = useState(false)
  const [imgFailed, setImgFailed] = useState(false)

  const imgUrl = getImageUrl(edition.asset_path_prefix)
  const videoUrl = getVideoUrl(edition.asset_path_prefix)
  const showVideo = hovered || imgFailed

  // Fetch live Flowty listings for this edition
  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      setError(null)
      try {
        // Build edition key from set/play IDs — use the edition ID which is already setID:playID format
        // We fetch from Flowty via our existing proxy pattern
        const res = await fetch(
          `/api/market-listings?edition=${encodeURIComponent(edition.id)}`,
          { signal: AbortSignal.timeout(12000) }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (!cancelled) {
          setListings(json.listings ?? [])
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? "Failed to load listings")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [edition.id])

  const tierUpper = edition.tier.toUpperCase().replace("MOMENT_TIER_", "")
  const holo = holoClass(edition.tier)
  const tc = tierColor(edition.tier)

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "24px 16px", overflowY: "auto",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        className={holo}
        style={{
          width: "100%", maxWidth: 720,
          background: "var(--rpc-bg)", border: "1px solid var(--rpc-border)",
          borderRadius: 12, overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", gap: 16, padding: 20,
          borderBottom: "1px solid var(--rpc-border)",
          background: "var(--rpc-surface)",
        }}>
          {/* Media */}
          <div
            style={{ width: 80, height: 80, borderRadius: 8, overflow: "hidden", flexShrink: 0, background: "var(--rpc-surface-raised)", cursor: "pointer" }}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
          >
            {imgUrl && !imgFailed && !showVideo && (
              <img src={imgUrl} alt={edition.player_name} style={{ width: "100%", height: "100%", objectFit: "cover" }} onError={() => setImgFailed(true)} />
            )}
            {videoUrl && showVideo && (
              <video src={videoUrl} autoPlay loop muted playsInline style={{ width: "100%", height: "100%", objectFit: "cover" }} />
            )}
          </div>

          {/* Info */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
              <div>
                <div className="rpc-heading" style={{ fontSize: "var(--text-lg)", marginBottom: 4 }}>
                  {edition.player_name}
                </div>
                <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginBottom: 8 }}>
                  {edition.set_name} · {seriesLabel(edition.series_number)} · <span style={{ color: tc }}>{tierUpper}</span>
                  {edition.parallel_id !== 0 && (
                    <span style={{ color: parallelColor(edition.parallel_id) }}> · {edition.parallel_display}</span>
                  )}
                </div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {edition.badge_titles.map(b => <BadgePill key={b} title={b} />)}
                </div>
              </div>
              <button
                onClick={onClose}
                style={{
                  background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)",
                  borderRadius: 6, padding: "4px 10px", cursor: "pointer",
                  fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-muted)",
                  flexShrink: 0,
                }}
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
          borderBottom: "1px solid var(--rpc-border)",
        }}>
          {[
            { label: "FMV", value: fmt(edition.avg_sale_price) },
            { label: "LOW ASK", value: fmt(edition.low_ask) },
            { label: "BEST OFFER", value: fmt(edition.highest_offer) },
            { label: "SUPPLY", value: edition.circulation_count.toLocaleString() },
          ].map(({ label, value }) => (
            <div key={label} style={{
              padding: "12px 16px", textAlign: "center",
              borderRight: "1px solid var(--rpc-border)",
            }}>
              <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", marginBottom: 4 }}>{label}</div>
              <div className="rpc-mono" style={{ fontSize: "var(--text-sm)", color: "var(--rpc-text)" }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Listings table */}
        <div style={{ padding: 20 }}>
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", marginBottom: 12 }}>
            LIVE LISTINGS {!loading && listings.length > 0 && `· ${listings.length} FOUND`}
          </div>

          {loading && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[...Array(5)].map((_, i) => (
                <div key={i} className="rpc-skeleton" style={{ height: 44, borderRadius: 8 }} />
              ))}
            </div>
          )}

          {error && (
            <div className="rpc-mono" style={{ color: "var(--rpc-error)", fontSize: "var(--text-sm)", padding: "20px 0" }}>
              ⚠ {error}
            </div>
          )}

          {!loading && !error && listings.length === 0 && (
            <div style={{ padding: "40px 0", textAlign: "center" }}>
              <div style={{ fontSize: 32, marginBottom: 8, opacity: 0.3 }}>📭</div>
              <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
                No active listings found
              </div>
            </div>
          )}

          {!loading && listings.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {listings.map((listing, i) => {
                const isOwned = ownedSerials.has(listing.serial)
                const fmv = edition.avg_sale_price
                const discount = fmv && fmv > 0
                  ? Math.round((1 - listing.salePrice / fmv) * 100)
                  : null
                const isGoodDeal = discount != null && discount >= 10

                return (
                  <div
                    key={listing.listingResourceID}
                    style={{
                      display: "flex", alignItems: "center", gap: 12,
                      padding: "10px 14px", borderRadius: 8,
                      background: i === 0
                        ? "rgba(224,58,47,0.06)"
                        : "var(--rpc-surface)",
                      border: i === 0
                        ? "1px solid rgba(224,58,47,0.2)"
                        : "1px solid var(--rpc-border)",
                    }}
                  >
                    {/* Rank */}
                    <div className="rpc-mono" style={{
                      width: 20, textAlign: "center", fontSize: 11,
                      color: i === 0 ? "var(--rpc-red)" : "var(--rpc-text-ghost)",
                      fontWeight: i === 0 ? 700 : 400,
                    }}>
                      {i + 1}
                    </div>

                    {/* Serial */}
                    <div className="rpc-mono" style={{ flex: 1, fontSize: "var(--text-sm)" }}>
                      #{listing.serial.toLocaleString()}
                      {isOwned && (
                        <span style={{
                          marginLeft: 8, fontSize: 9, padding: "1px 5px",
                          background: "rgba(74,222,128,0.12)", color: "#4ade80",
                          border: "1px solid rgba(74,222,128,0.25)", borderRadius: 4,
                          letterSpacing: "0.05em",
                        }}>
                          OWNED
                        </span>
                      )}
                    </div>

                    {/* Discount */}
                    {discount != null && (
                      <div className="rpc-mono" style={{
                        fontSize: 11, fontWeight: 700,
                        color: isGoodDeal ? "var(--rpc-success)" : "var(--rpc-text-muted)",
                      }}>
                        {discount > 0 ? `-${discount}%` : discount < 0 ? `+${Math.abs(discount)}%` : "AT FMV"}
                      </div>
                    )}

                    {/* Price */}
                    <div className="rpc-mono" style={{
                      fontSize: "var(--text-base)", fontWeight: 700,
                      color: i === 0 ? "var(--rpc-red)" : "var(--rpc-text)",
                      minWidth: 64, textAlign: "right",
                    }}>
                      {fmt(listing.salePrice)}
                    </div>

                    {/* Buy button */}
                    <a
                      href={`https://www.flowty.io/listing/${listing.listingResourceID}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        padding: "6px 14px", borderRadius: 6,
                        background: "var(--rpc-info)", color: "#fff",
                        fontFamily: "var(--font-mono)", fontSize: 11,
                        fontWeight: 700, letterSpacing: "0.05em",
                        textDecoration: "none", flexShrink: 0,
                        transition: "opacity 0.15s",
                      }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = "0.8")}
                      onMouseLeave={e => (e.currentTarget.style.opacity = "1")}
                    >
                      FLOWTY ↗
                    </a>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──────────────────────────────────────────────────────────────────

function MarketPageInner() {
  const searchParams = useSearchParams()
  const router = useRouter()

  // ── Filter state ──────────────────────────────────────────────────────────
  const [player, setPlayer]         = useState("")
  const [playerInput, setPlayerInput] = useState("")
  const [setName, setSetName]       = useState("")
  const [series, setSeries]         = useState("")
  const [tier, setTier]             = useState("")
  const [team, setTeam]             = useState("")
  const [parallel, setParallel]     = useState("")
  const [badgeFilter, setBadgeFilter] = useState("")
  const [minPrice, setMinPrice]     = useState("")
  const [maxPrice, setMaxPrice]     = useState("")
  const [minFmv, setMinFmv]         = useState("")
  const [maxFmv, setMaxFmv]         = useState("")
  const [minSerial, setMinSerial]   = useState("")
  const [maxSerial, setMaxSerial]   = useState("")
  const [minDiscount, setMinDiscount] = useState("")
  const [jerseySerial, setJerseySerial] = useState(false)
  const [lastMint, setLastMint]     = useState(false)
  const [notOwned, setNotOwned]     = useState(false)
  const [sort, setSort]             = useState("low_ask")
  const [dir, setDir]               = useState<"asc" | "desc">("asc")
  const [showFilters, setShowFilters] = useState(true)

  // ── Data state ────────────────────────────────────────────────────────────
  const [editions, setEditions]     = useState<BadgeEdition[]>([])
  const [meta, setMeta]             = useState<Meta | null>(null)
  const [loading, setLoading]       = useState(false)
  const [offset, setOffset]         = useState(0)
  const [loadingMore, setLoadingMore] = useState(false)

  // ── Wallet / owned state ──────────────────────────────────────────────────
  const [ownerKey, setOwnerKey]     = useState<string | null>(null)
  const [walletAddress, setWalletAddress] = useState<string>("")
  const [walletInput, setWalletInput] = useState<string>("")
  const [ownedEditionIds, setOwnedEditionIds] = useState<Set<string>>(new Set())
  const [ownedSerialMap, setOwnedSerialMap]   = useState<Map<string, Set<number>>>(new Map())
  const [walletLoading, setWalletLoading]     = useState(false)

  // ── Modal state ───────────────────────────────────────────────────────────
  const [selectedEdition, setSelectedEdition] = useState<BadgeEdition | null>(null)

  // ── Debounce ref ──────────────────────────────────────────────────────────
  const playerDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Read wallet from URL on mount ─────────────────────────────────────────
  useEffect(() => {
    setOwnerKey(getOwnerKey())
    return onOwnerKeyChange(k => setOwnerKey(k))
  }, [])

  useEffect(() => {
    const addr = searchParams.get("address") ?? ""
    if (addr) {
      setWalletAddress(addr)
      setWalletInput(addr)
    }
  }, [searchParams])

  // ── Fetch owned moments when wallet changes ───────────────────────────────
  useEffect(() => {
    if (!walletAddress) {
      setOwnedEditionIds(new Set())
      setOwnedSerialMap(new Map())
      return
    }
    let cancelled = false
    async function load() {
      setWalletLoading(true)
      try {
        const res = await fetch("/api/wallet-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ input: walletAddress }),
          signal: AbortSignal.timeout(15000),
        })
        if (!res.ok) throw new Error("wallet search failed")
        const json = await res.json()
        const moments: any[] = json.moments ?? json.data ?? []
        if (!cancelled) {
          const edIds = new Set<string>()
          const serialMap = new Map<string, Set<number>>()
          for (const m of moments) {
            const setId = m.setID ?? m.set?.id
            const playId = m.playID ?? m.play?.id
            const serial = m.serialNumber ?? m.flowSerialNumber
            if (setId && playId) {
              const key = `${setId}:${playId}`
              edIds.add(key)
              if (serial) {
                if (!serialMap.has(key)) serialMap.set(key, new Set())
                serialMap.get(key)!.add(Number(serial))
              }
            }
          }
          setOwnedEditionIds(edIds)
          setOwnedSerialMap(serialMap)
        }
      } catch {
        if (!cancelled) {
          setOwnedEditionIds(new Set())
          setOwnedSerialMap(new Map())
        }
      } finally {
        if (!cancelled) setWalletLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [walletAddress])

  // ── Build API params ───────────────────────────────────────────────────────
  function buildParams(off: number): URLSearchParams {
    const p = new URLSearchParams({
      mode: "all",
      sort,
      dir,
      limit: String(PAGE_SIZE),
      offset: String(off),
    })
    if (player)   p.set("player", player)
    if (setName)  p.set("set_name", setName)
    if (series)   p.set("series", series)
    if (tier)     p.set("tier", tier)
    if (team)     p.set("team", team)
    if (parallel) p.set("parallel", parallel)
    if (badgeFilter) p.set("badge_filter", badgeFilter)
    if (minPrice) p.set("min_price", minPrice)
    if (maxPrice) p.set("max_price", maxPrice)
    if (minFmv)   p.set("min_fmv", minFmv)
    if (maxFmv)   p.set("max_fmv", maxFmv)
    if (minSerial) p.set("min_serial", minSerial)
    if (maxSerial) p.set("max_serial", maxSerial)
    if (minDiscount) p.set("min_discount_pct", minDiscount)
    if (jerseySerial) p.set("jersey_serial", "true")
    if (lastMint)    p.set("last_mint", "true")
    return p
  }

  // ── Fetch editions ─────────────────────────────────────────────────────────
  const fetchEditions = useCallback(async (off: number, append = false) => {
    if (append) setLoadingMore(true)
    else        setLoading(true)
    try {
      const params = buildParams(off)
      const res = await fetch(`/api/market?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const rows: BadgeEdition[] = json.editions ?? []
      if (append) setEditions(prev => [...prev, ...rows])
      else        setEditions(rows)
      setMeta(json.meta ?? null)
      setOffset(off)
    } catch (e) {
      console.error("[market] fetch error", e)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player, setName, series, tier, team, parallel, badgeFilter, minPrice, maxPrice, minFmv, maxFmv, minSerial, maxSerial, minDiscount, jerseySerial, lastMint, sort, dir])

  // Initial load + re-fetch on filter changes
  useEffect(() => {
    fetchEditions(0, false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchEditions])

  // ── Filter helpers ─────────────────────────────────────────────────────────
  function handlePlayerInput(val: string) {
    setPlayerInput(val)
    if (playerDebounce.current) clearTimeout(playerDebounce.current)
    playerDebounce.current = setTimeout(() => setPlayer(val.trim()), 400)
  }

  function resetFilters() {
    setPlayer(""); setPlayerInput("")
    setSetName(""); setSeries(""); setTier(""); setTeam("")
    setParallel(""); setBadgeFilter("")
    setMinPrice(""); setMaxPrice("")
    setMinFmv(""); setMaxFmv("")
    setMinSerial(""); setMaxSerial("")
    setMinDiscount("")
    setJerseySerial(false); setLastMint(false); setNotOwned(false)
    setSort("low_ask"); setDir("asc")
  }

  function handleWalletApply() {
    const addr = walletInput.trim()
    setWalletAddress(addr)
    const params = new URLSearchParams(searchParams.toString())
    if (addr) params.set("address", addr)
    else params.delete("address")
    router.replace(`?${params.toString()}`, { scroll: false })
  }

  // ── Client-side owned filter ───────────────────────────────────────────────
  const displayEditions = useMemo(() => {
    if (!notOwned || ownedEditionIds.size === 0) return editions
    return editions.filter(e => !ownedEditionIds.has(e.id))
  }, [editions, notOwned, ownedEditionIds])

  const hasMore = meta ? (offset + PAGE_SIZE) < meta.total : false

  // ── Sort toggle helper ─────────────────────────────────────────────────────
  function handleSort(col: string) {
    if (sort === col) setDir(d => d === "asc" ? "desc" : "asc")
    else { setSort(col); setDir("asc") }
  }

  function sortIndicator(col: string) {
    if (sort !== col) return <span style={{ opacity: 0.25, marginLeft: 4 }}>↕</span>
    return <span style={{ marginLeft: 4, color: "var(--rpc-red)" }}>{dir === "asc" ? "↑" : "↓"}</span>
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: "20px 16px", maxWidth: 1200, margin: "0 auto" }}>

      {/* Page header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h1 className="rpc-heading" style={{ fontSize: "var(--text-2xl)", marginBottom: 4 }}>
              MARKET
            </h1>
            <p className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
              Browse all listings · filter by player, set, tier, badges, price, and more
            </p>
          </div>
          <button
            onClick={() => setShowFilters(f => !f)}
            style={{
              padding: "6px 14px", borderRadius: 6, cursor: "pointer",
              fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
              background: "var(--rpc-surface-raised)", color: "var(--rpc-text-muted)",
              border: "1px solid var(--rpc-border)",
            }}
          >
            {showFilters ? "HIDE FILTERS" : "SHOW FILTERS"}
          </button>
        </div>
      </div>

      {/* ── Filter panel ─────────────────────────────────────────────────── */}
      {showFilters && (
        <div className="rpc-card" style={{ marginBottom: 16, padding: 16 }}>

          {/* Row 1: Player + Set + Wallet */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>PLAYER</label>
              <input
                type="text"
                placeholder="e.g. LeBron James"
                value={playerInput}
                onChange={e => handlePlayerInput(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>SET NAME</label>
              <input
                type="text"
                placeholder="e.g. Base Set"
                value={setName}
                onChange={e => setSetName(e.target.value)}
                onBlur={() => fetchEditions(0)}
                onKeyDown={e => e.key === "Enter" && fetchEditions(0)}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>WALLET (OWNED FILTER)</label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  placeholder="0x… or username"
                  value={walletInput}
                  onChange={e => setWalletInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleWalletApply()}
                  style={{ ...inputStyle, flex: 1 }}
                />
                <button
                  onClick={handleWalletApply}
                  disabled={walletLoading}
                  style={{
                    padding: "0 10px", borderRadius: 6, cursor: "pointer",
                    background: "var(--rpc-red)", color: "#fff",
                    fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700,
                    border: "none", opacity: walletLoading ? 0.5 : 1, flexShrink: 0,
                  }}
                >
                  {walletLoading ? "…" : "GO"}
                </button>
              </div>
            </div>
          </div>

          {/* Row 2: Series + Tier + Team + Parallel */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>SERIES</label>
              <select value={series} onChange={e => setSeries(e.target.value)} style={selectStyle}>
                <option value="">All Series</option>
                {Object.entries(SERIES_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>TIER</label>
              <select value={tier} onChange={e => setTier(e.target.value)} style={selectStyle}>
                <option value="">All Tiers</option>
                {TIER_ORDER.map(t => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
              </select>
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>PARALLEL</label>
              <select value={parallel} onChange={e => setParallel(e.target.value)} style={selectStyle}>
                <option value="">All Parallels</option>
                <option value="0">Standard</option>
                <option value="17">Blockchain</option>
                <option value="18">Hardcourt</option>
                <option value="19">Hexwave</option>
                <option value="20">Jukebox</option>
              </select>
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>BADGES</label>
              <select value={badgeFilter} onChange={e => setBadgeFilter(e.target.value)} style={selectStyle}>
                <option value="">Any Badges</option>
                <option value="ts">TS (Top Shot Debut)</option>
                <option value="ry">RY (Rookie Year)</option>
                <option value="rm">RM (Rookie Mint)</option>
                <option value="rp">RP (Rookie Premiere)</option>
                <option value="cy">CY (Championship Year)</option>
                <option value="cr">CR (Championship Run)</option>
                <option value="roty">ROTY</option>
              </select>
            </div>
          </div>

          {/* Row 3: Price ranges */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>PRICE RANGE</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="number" placeholder="Min $" value={minPrice} onChange={e => setMinPrice(e.target.value)} style={inputStyle} min="0" />
                <span className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", fontSize: 12 }}>→</span>
                <input type="number" placeholder="Max $" value={maxPrice} onChange={e => setMaxPrice(e.target.value)} style={inputStyle} min="0" />
              </div>
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>FMV RANGE</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="number" placeholder="Min $" value={minFmv} onChange={e => setMinFmv(e.target.value)} style={inputStyle} min="0" />
                <span className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", fontSize: 12 }}>→</span>
                <input type="number" placeholder="Max $" value={maxFmv} onChange={e => setMaxFmv(e.target.value)} style={inputStyle} min="0" />
              </div>
            </div>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>SERIAL RANGE</label>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="number" placeholder="Min #" value={minSerial} onChange={e => setMinSerial(e.target.value)} style={inputStyle} min="1" />
                <span className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", fontSize: 12 }}>→</span>
                <input type="number" placeholder="Max #" value={maxSerial} onChange={e => setMaxSerial(e.target.value)} style={inputStyle} min="1" />
              </div>
            </div>
          </div>

          {/* Row 4: Min discount + toggles + sort */}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16, flexWrap: "wrap" }}>
            <div>
              <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>MIN % DISCOUNT FROM FMV</label>
              <input
                type="number"
                placeholder="e.g. 10"
                value={minDiscount}
                onChange={e => setMinDiscount(e.target.value)}
                style={{ ...inputStyle, width: 140 }}
                min="0" max="100"
              />
            </div>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingBottom: 2 }}>
              <FilterToggle label="JERSEY #" active={jerseySerial} onClick={() => setJerseySerial(v => !v)} />
              <FilterToggle label="LAST MINT" active={lastMint} onClick={() => setLastMint(v => !v)} />
              <FilterToggle
                label={walletAddress ? "NOT OWNED" : "NOT OWNED (connect wallet)"}
                active={notOwned}
                onClick={() => walletAddress && setNotOwned(v => !v)}
              />
            </div>

            <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div>
                <label className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em", display: "block", marginBottom: 4 }}>SORT</label>
                <select value={sort} onChange={e => { setSort(e.target.value); setDir("asc") }} style={{ ...selectStyle, width: 160 }}>
                  <option value="low_ask">Low Ask</option>
                  <option value="avg_sale_price">FMV</option>
                  <option value="badge_score">Badge Score</option>
                  <option value="burn_rate_pct">Burn Rate</option>
                  <option value="lock_rate_pct">Lock Rate</option>
                  <option value="circulation_count">Circulation</option>
                  <option value="player_name">Player Name</option>
                </select>
              </div>
              <button
                onClick={() => setDir(d => d === "asc" ? "desc" : "asc")}
                title={`Sort ${dir === "asc" ? "descending" : "ascending"}`}
                style={{
                  padding: "0 12px", height: 34, borderRadius: 6, cursor: "pointer",
                  background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)",
                  fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-muted)",
                }}
              >
                {dir === "asc" ? "↑" : "↓"}
              </button>
              <button
                onClick={resetFilters}
                style={{
                  padding: "0 14px", height: 34, borderRadius: 6, cursor: "pointer",
                  fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
                  background: "var(--rpc-surface-raised)", color: "var(--rpc-text-muted)",
                  border: "1px solid var(--rpc-border)",
                }}
              >
                RESET
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Results count */}
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 12 }}>
        <span className="rpc-mono" style={{ fontSize: "var(--text-sm)", color: "var(--rpc-text-muted)" }}>
          {loading ? "Loading…" : meta ? `${meta.total.toLocaleString()} editions` : "—"}
        </span>
        {walletAddress && (
          <span className="rpc-mono" style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 4,
            background: "rgba(74,222,128,0.1)", color: "#4ade80",
            border: "1px solid rgba(74,222,128,0.2)",
          }}>
            {walletLoading ? "LOADING WALLET…" : `WALLET: ${walletAddress.slice(0, 10)}…`}
          </span>
        )}
        {notOwned && ownedEditionIds.size > 0 && (
          <span className="rpc-mono" style={{
            fontSize: 10, padding: "2px 8px", borderRadius: 4,
            background: "rgba(59,130,246,0.1)", color: "var(--rpc-info)",
            border: "1px solid rgba(59,130,246,0.2)",
          }}>
            SHOWING NOT OWNED
          </span>
        )}
      </div>

      {/* ── Table ────────────────────────────────────────────────────────── */}
      <div className="rpc-card" style={{ overflow: "hidden", padding: 0 }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
                {/* Thumb */}
                <th style={{ width: 52, padding: "10px 12px" }} />
                {/* Own */}
                {walletAddress && (
                  <th style={{ ...thStyle, width: 44 }}>
                    <span className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em" }}>OWN</span>
                  </th>
                )}
                <th style={thStyle} onClick={() => handleSort("low_ask")}>
                  FMV {sortIndicator("avg_sale_price")}
                </th>
                <th style={thStyle} onClick={() => handleSort("low_ask")}>
                  LOW ASK {sortIndicator("low_ask")}
                </th>
                <th style={{ ...thStyle, minWidth: 180 }}>PLAYER</th>
                <th style={{ ...thStyle, minWidth: 180 }}>SET</th>
                <th style={thStyle} onClick={() => handleSort("circulation_count")}>
                  SUPPLY {sortIndicator("circulation_count")}
                </th>
                <th style={thStyle} onClick={() => handleSort("burn_rate_pct")}>
                  BURN {sortIndicator("burn_rate_pct")}
                </th>
                <th style={thStyle}>BADGES</th>
                <th style={{ ...thStyle, width: 80 }}>ACTION</th>
              </tr>
            </thead>
            <tbody>
              {loading && [...Array(12)].map((_, i) => (
                <tr key={i} style={{ borderBottom: "1px solid var(--rpc-border)" }}>
                  <td colSpan={10} style={{ padding: 8 }}>
                    <div className="rpc-skeleton" style={{ height: 36, borderRadius: 6 }} />
                  </td>
                </tr>
              ))}

              {!loading && displayEditions.map(e => {
                const tc2 = tierColor(e.tier)
                const isOwned = ownedEditionIds.has(e.id)
                const holo2 = holoClass(e.tier)

                return (
                  <tr
                    key={e.id}
                    className={`group ${holo2}`}
                    style={{
                      borderBottom: "1px solid var(--rpc-border)",
                      cursor: "pointer",
                      transition: "background 0.1s",
                    }}
                    onClick={() => setSelectedEdition(e)}
                    onMouseEnter={ev => (ev.currentTarget.style.background = "var(--rpc-surface)")}
                    onMouseLeave={ev => (ev.currentTarget.style.background = "")}
                  >
                    {/* Thumb */}
                    <td style={{ padding: "8px 10px", width: 52 }}>
                      <MomentThumb prefix={e.asset_path_prefix} playerName={e.player_name} size={36} />
                    </td>

                    {/* Own indicator */}
                    {walletAddress && (
                      <td style={{ padding: "8px 6px", textAlign: "center" }}>
                        {isOwned && (
                          <span style={{
                            display: "inline-block", width: 8, height: 8, borderRadius: "50%",
                            background: "#4ade80",
                          }} title="You own this edition" />
                        )}
                      </td>
                    )}

                    {/* FMV */}
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <span className="rpc-mono" style={{ fontSize: "var(--text-sm)", color: "var(--rpc-text-muted)" }}>
                        {fmt(e.avg_sale_price)}
                      </span>
                    </td>

                    {/* Low Ask */}
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <span className="rpc-mono" style={{
                        fontSize: "var(--text-sm)", fontWeight: 700,
                        color: e.low_ask && e.avg_sale_price && e.low_ask < e.avg_sale_price
                          ? "var(--rpc-success)"
                          : e.low_ask && e.avg_sale_price && e.low_ask > e.avg_sale_price * 1.1
                          ? "var(--rpc-warning, #f59e0b)"
                          : "var(--rpc-text)",
                      }}>
                        {fmt(e.low_ask)}
                      </span>
                    </td>

                    {/* Player */}
                    <td style={{ padding: "8px 12px" }}>
                      <div className="rpc-mono" style={{ fontSize: "var(--text-sm)", fontWeight: 600 }}>
                        {e.player_name}
                      </div>
                      <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-ghost)" }}>
                        <span style={{ color: tc2 }}>{e.tier_display}</span>
                        {e.parallel_id !== 0 && (
                          <span style={{ color: parallelColor(e.parallel_id) }}> · {e.parallel_display}</span>
                        )}
                      </div>
                    </td>

                    {/* Set */}
                    <td style={{ padding: "8px 12px" }}>
                      <div className="rpc-mono" style={{ fontSize: "var(--text-sm)" }}>
                        {e.set_name}
                      </div>
                      <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-ghost)" }}>
                        {seriesLabel(e.series_number)}
                      </div>
                    </td>

                    {/* Supply */}
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <span className="rpc-mono" style={{ fontSize: "var(--text-sm)", color: "var(--rpc-text-muted)" }}>
                        {e.circulation_count.toLocaleString()}
                      </span>
                    </td>

                    {/* Burn rate */}
                    <td style={{ padding: "8px 12px", whiteSpace: "nowrap" }}>
                      <span className="rpc-mono" style={{
                        fontSize: "var(--text-sm)",
                        color: e.burn_rate_pct >= 20
                          ? "var(--rpc-success)"
                          : e.burn_rate_pct >= 10
                          ? "var(--rpc-warning, #f59e0b)"
                          : "var(--rpc-text-muted)",
                      }}>
                        {fmtPct(e.burn_rate_pct)}
                      </span>
                    </td>

                    {/* Badges */}
                    <td style={{ padding: "8px 12px" }}>
                      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                        {e.badge_titles.slice(0, 3).map(b => <BadgePill key={b} title={b} />)}
                      </div>
                    </td>

                    {/* Action */}
                    <td style={{ padding: "8px 10px" }} onClick={ev => ev.stopPropagation()}>
                      <button
                        onClick={() => setSelectedEdition(e)}
                        style={{
                          padding: "5px 12px", borderRadius: 6, cursor: "pointer",
                          background: "var(--rpc-red)", color: "#fff",
                          fontFamily: "var(--font-mono)", fontSize: 10,
                          fontWeight: 700, border: "none", letterSpacing: "0.05em",
                          whiteSpace: "nowrap",
                        }}
                      >
                        SELECT
                      </button>
                    </td>
                  </tr>
                )
              })}

              {!loading && displayEditions.length === 0 && (
                <tr>
                  <td colSpan={10} style={{ padding: "60px 0", textAlign: "center" }}>
                    <div style={{ fontSize: 36, marginBottom: 8, opacity: 0.25 }}>🔍</div>
                    <div className="rpc-heading" style={{ fontSize: "var(--text-base)", marginBottom: 4 }}>
                      NO EDITIONS FOUND
                    </div>
                    <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
                      Try adjusting your filters
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Load more */}
      {hasMore && !loading && (
        <div style={{ display: "flex", justifyContent: "center", marginTop: 16 }}>
          <button
            onClick={() => fetchEditions(offset + PAGE_SIZE, true)}
            disabled={loadingMore}
            style={{
              padding: "10px 32px", borderRadius: 8, cursor: "pointer",
              fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700,
              letterSpacing: "0.05em",
              background: loadingMore ? "var(--rpc-surface)" : "var(--rpc-surface-raised)",
              color: "var(--rpc-text-muted)",
              border: "1px solid var(--rpc-border)",
              opacity: loadingMore ? 0.5 : 1,
            }}
          >
            {loadingMore
              ? "LOADING…"
              : `LOAD MORE (${(meta!.total - offset - PAGE_SIZE).toLocaleString()} REMAINING)`}
          </button>
        </div>
      )}

      {/* Listings modal */}
      {selectedEdition && (
        <ListingsModal
          edition={selectedEdition}
          ownedSerials={ownedSerialMap.get(selectedEdition.id) ?? new Set()}
          onClose={() => setSelectedEdition(null)}
        />
      )}
    </div>
  )
}

// ── Shared input/select styles ─────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: 6,
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  color: "var(--rpc-text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
}

const selectStyle: React.CSSProperties = {
  ...inputStyle,
  cursor: "pointer",
  appearance: "none",
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23666'/%3E%3C/svg%3E")`,
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 10px center",
  paddingRight: 28,
}

const thStyle: React.CSSProperties = {
  padding: "10px 12px",
  textAlign: "left",
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.1em",
  color: "var(--rpc-text-ghost)",
  cursor: "pointer",
  userSelect: "none",
  whiteSpace: "nowrap",
}

export default function MarketPage() {
  return (
    <Suspense>
      <MarketPageInner />
    </Suspense>
  )
}
