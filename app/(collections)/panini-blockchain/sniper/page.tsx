"use client"

import { useEffect, useState, useCallback, useRef } from "react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface Listing {
  id: string
  name: string
  image_url: string | null
  traits: Record<string, string>
  price_eth: number
  price_usd: number | null
  seller: string
  buy_url: string
  listed_at: string | null
}

interface ListingsResponse {
  listings: Listing[]
  floor_eth: number | null
  count: number
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortenAddress(addr: string) {
  if (!addr || addr.length < 10) return addr
  return addr.slice(0, 6) + "…" + addr.slice(-4)
}

function fmtEth(n: number) {
  if (n >= 1) return n.toFixed(3) + " ETH"
  return n.toFixed(4) + " ETH"
}

function fmtUsd(n: number | null) {
  if (n == null) return null
  return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function timeAgo(iso: string | null) {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m ago"
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return hrs + "h ago"
  return Math.floor(hrs / 24) + "d ago"
}

// ── Tier badge colors ─────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  legendary: "#F59E0B",
  epic: "#A855F7",
  rare: "#3B82F6",
  uncommon: "#22C55E",
  common: "#6B7280",
}

function tierColor(tier: string | undefined) {
  if (!tier) return undefined
  return TIER_COLORS[tier.toLowerCase()] ?? "#6B7280"
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaniniSniperPage() {
  const accent = "#C084FC"

  const [data, setData] = useState<ListingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Controls
  const [search, setSearch] = useState("")
  const [maxPrice, setMaxPrice] = useState("")
  const [sort, setSort] = useState<"price-asc" | "price-desc" | "newest">("price-asc")

  // Auto-refresh
  const [countdown, setCountdown] = useState(60)
  const [paused, setPaused] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchListings = useCallback(async () => {
    try {
      setError(null)
      const res = await fetch("/api/panini/listings")
      if (!res.ok) throw new Error("Failed to load listings")
      const json: ListingsResponse = await res.json()
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load listings")
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchListings()
  }, [fetchListings])

  // Countdown timer
  useEffect(() => {
    if (paused) {
      if (timerRef.current) clearInterval(timerRef.current)
      return
    }
    timerRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          fetchListings()
          return 60
        }
        return c - 1
      })
    }, 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [paused, fetchListings])

  // Filter and sort
  const filtered = (data?.listings ?? [])
    .filter((l) => {
      if (search) {
        const q = search.toLowerCase()
        const nameMatch = l.name?.toLowerCase().includes(q)
        const traitMatch = Object.values(l.traits).some((v) => v.toLowerCase().includes(q))
        if (!nameMatch && !traitMatch) return false
      }
      if (maxPrice && l.price_eth > parseFloat(maxPrice)) return false
      return true
    })
    .sort((a, b) => {
      if (sort === "price-asc") return a.price_eth - b.price_eth
      if (sort === "price-desc") return b.price_eth - a.price_eth
      // newest
      if (!a.listed_at || !b.listed_at) return 0
      return new Date(b.listed_at).getTime() - new Date(a.listed_at).getTime()
    })

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Notice Banner ── */}
      <div className="rpc-card" style={{ padding: "10px 16px", border: `1px solid ${accent}33` }}>
        <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
          Showing bridged Panini cards only — these exist as Ethereum NFTs. Cards not yet bridged trade on{" "}
          <a href="https://nft.paniniamerica.net" target="_blank" rel="noreferrer" style={{ color: accent, textDecoration: "none" }}>nft.paniniamerica.net</a>.
        </div>
      </div>

      {/* ── Header Stats + Controls ── */}
      <div className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginBottom: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: paused ? "var(--rpc-text-ghost)" : "var(--rpc-success)", animation: paused ? "none" : "pulse 2s infinite" }} />
            <span className="rpc-label">OpenSea Listings</span>
          </div>
          {data && (
            <>
              <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: accent }}>
                Floor: {data.floor_eth != null ? fmtEth(data.floor_eth) : "—"}
              </span>
              <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
                {data.count} listing{data.count !== 1 ? "s" : ""}
              </span>
            </>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
              {paused ? "PAUSED" : `${countdown}s`}
            </span>
            <button
              onClick={() => { setPaused(!paused); if (paused) setCountdown(60) }}
              style={{ padding: "4px 10px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", cursor: "pointer" }}
            >
              {paused ? "▶ RESUME" : "⏸ PAUSE"}
            </button>
          </div>
        </div>

        {/* Controls row */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or traits…"
            style={{ flex: 1, minWidth: 200, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
          />
          <input
            type="number"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            placeholder="Max ETH"
            step="0.01"
            min="0"
            style={{ width: 120, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            style={{ padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none", cursor: "pointer" }}
          >
            <option value="price-asc">Price: Low → High</option>
            <option value="price-desc">Price: High → Low</option>
            <option value="newest">Newest First</option>
          </select>
        </div>
      </div>

      {/* ── Listings ── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rpc-card" style={{ padding: "14px 16px", display: "flex", gap: 14, alignItems: "center" }}>
              <div className="rpc-skeleton" style={{ width: 52, height: 52, borderRadius: "var(--radius-sm)", flexShrink: 0 }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="rpc-skeleton" style={{ width: "40%", height: 14 }} />
                <div className="rpc-skeleton" style={{ width: "25%", height: 10 }} />
              </div>
              <div className="rpc-skeleton" style={{ width: 80, height: 20 }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rpc-card" style={{ padding: "32px 24px", textAlign: "center" }}>
          <div className="rpc-mono" style={{ color: "var(--rpc-danger, #EF4444)", marginBottom: 12 }}>{error}</div>
          <button
            onClick={() => { setLoading(true); fetchListings() }}
            style={{ padding: "8px 20px", background: accent, border: "none", borderRadius: "var(--radius-sm)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-sm)", cursor: "pointer", letterSpacing: "0.04em" }}
          >
            RETRY
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rpc-card" style={{ padding: "32px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>🃏</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-lg)", color: "var(--rpc-text-primary)", marginBottom: 8 }}>
            No Listings Found
          </div>
          <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
            {search || maxPrice
              ? "No listings match your filters. Try adjusting your search or removing the price limit."
              : "The Ethereum bridge just opened — listings will appear as collectors bridge and list their cards on OpenSea."}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((listing) => {
            const setName = listing.traits["Set Name"] ?? listing.traits["set name"] ?? listing.traits["set_name"]
            const serial = listing.traits["Serial Number"] ?? listing.traits["serial number"] ?? listing.traits["serial_number"]
            const circulation = listing.traits["Circulation Count"] ?? listing.traits["circulation count"] ?? listing.traits["circulation_count"]
            const tier = listing.traits["Tier"] ?? listing.traits["tier"]
            const tc = tierColor(tier)

            return (
              <div key={listing.id} className="rpc-card" style={{ padding: "12px 16px", display: "flex", gap: 14, alignItems: "center" }}>
                {/* Thumbnail */}
                <div style={{ width: 52, height: 52, borderRadius: "var(--radius-sm)", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
                  {listing.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={listing.image_url} alt={listing.name} style={{ width: 52, height: 52, objectFit: "cover" }} />
                  ) : (
                    <span style={{ fontSize: 24 }}>🃏</span>
                  )}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {listing.name || "Panini Card"}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                    {setName && <span>{setName}</span>}
                    {serial && <span>#{serial}{circulation ? `/${circulation}` : ""}</span>}
                    {tier && <span style={{ color: tc, fontWeight: 700 }}>{tier}</span>}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", marginTop: 2 }}>
                    {shortenAddress(listing.seller)} · {timeAgo(listing.listed_at)}
                  </div>
                </div>

                {/* Price + Buy */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", color: accent }}>
                    {fmtEth(listing.price_eth)}
                  </div>
                  {listing.price_usd != null && (
                    <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
                      {fmtUsd(listing.price_usd)}
                    </div>
                  )}
                  <a
                    href={listing.buy_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ display: "inline-block", marginTop: 4, padding: "3px 12px", background: `${accent}22`, border: `1px solid ${accent}44`, borderRadius: "var(--radius-sm)", color: accent, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-xs)", textDecoration: "none", letterSpacing: "0.06em" }}
                  >
                    BUY →
                  </a>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
