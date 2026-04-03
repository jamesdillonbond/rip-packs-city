"use client"

import { useEffect, useState, useCallback, useRef } from "react"

// ── Types ─────────────────────────────────────────────────────────────────────

interface Listing {
  id: string
  name: string | null
  image_url: string | null
  traits: Record<string, string>
  price_eth: number
  price_usd: number | null
  seller: string
  listed_at: string
  buy_url: string
}

interface ListingsResponse {
  listings: Listing[]
  floor_eth: number | null
  count: number
  updated_at: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACCENT = "#C084FC"

const TIER_COLORS: Record<string, string> = {
  legendary: "#F59E0B",
  epic: "#A855F7",
  rare: "#3B82F6",
  uncommon: "#22C55E",
  common: "#9CA3AF",
}

function tierColor(tier: string | undefined) {
  if (!tier) return undefined
  return TIER_COLORS[tier.toLowerCase()] ?? "var(--rpc-text-muted)"
}

function shortenAddress(addr: string) {
  if (!addr || addr.length < 10) return addr
  return addr.slice(0, 6) + "…" + addr.slice(-4)
}

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return mins + "m ago"
  const hours = Math.floor(mins / 60)
  if (hours < 24) return hours + "h ago"
  return Math.floor(hours / 24) + "d ago"
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaniniSniperPage() {
  const [data, setData] = useState<ListingsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [search, setSearch] = useState("")
  const [maxPrice, setMaxPrice] = useState("")
  const [sort, setSort] = useState<"price-asc" | "price-desc" | "newest">("price-asc")
  const [countdown, setCountdown] = useState(60)
  const [paused, setPaused] = useState(false)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchListings = useCallback(async () => {
    try {
      setError(false)
      const res = await fetch("/api/panini/listings")
      if (!res.ok) throw new Error("fetch failed")
      const json: ListingsResponse = await res.json()
      setData(json)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchListings()
  }, [fetchListings])

  // Auto-refresh countdown
  useEffect(() => {
    if (paused) return
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          fetchListings()
          return 60
        }
        return prev - 1
      })
    }, 1000)
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current)
    }
  }, [paused, fetchListings])

  // Filter and sort
  const listings = data?.listings ?? []
  const filtered = listings
    .filter((l) => {
      if (search) {
        const q = search.toLowerCase()
        const nameMatch = l.name?.toLowerCase().includes(q)
        const traitMatch = Object.values(l.traits).some((v) =>
          v.toLowerCase().includes(q)
        )
        if (!nameMatch && !traitMatch) return false
      }
      if (maxPrice) {
        const max = parseFloat(maxPrice)
        if (!isNaN(max) && l.price_eth > max) return false
      }
      return true
    })
    .sort((a, b) => {
      if (sort === "price-asc") return a.price_eth - b.price_eth
      if (sort === "price-desc") return b.price_eth - a.price_eth
      // newest
      return new Date(b.listed_at).getTime() - new Date(a.listed_at).getTime()
    })

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Notice Banner ── */}
      <div
        className="rpc-card"
        style={{
          padding: "10px 16px",
          background: `${ACCENT}0A`,
          border: `1px solid ${ACCENT}33`,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ fontSize: 14 }}>🃏</span>
        <span
          className="rpc-mono"
          style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", lineHeight: 1.5 }}
        >
          Showing bridged Panini cards only — these exist as Ethereum NFTs. Cards not yet
          bridged trade on{" "}
          <a
            href="https://nft.paniniamerica.net"
            target="_blank"
            rel="noreferrer"
            style={{ color: ACCENT, textDecoration: "none" }}
          >
            nft.paniniamerica.net
          </a>
          .
        </span>
      </div>

      {/* ── Header + Controls ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: paused ? "var(--rpc-text-ghost)" : "var(--rpc-success)",
                animation: paused ? "none" : "pulse 2s infinite",
              }}
            />
            <span className="rpc-label">OpenSea Listings</span>
          </div>
          {data && (
            <span
              className="rpc-mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}
            >
              {data.floor_eth != null && (
                <>Floor: <span style={{ color: ACCENT, fontWeight: 700 }}>{data.floor_eth.toFixed(4)} ETH</span> · </>
              )}
              {data.count} listing{data.count !== 1 ? "s" : ""}
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className="rpc-mono"
              style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}
            >
              {paused ? "paused" : `${countdown}s`}
            </span>
            <button
              onClick={() => {
                setPaused((p) => !p)
                if (paused) setCountdown(60)
              }}
              style={{
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                color: "var(--rpc-text-muted)",
                padding: "3px 10px",
                borderRadius: 4,
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
                letterSpacing: "0.08em",
              }}
            >
              {paused ? "RESUME" : "PAUSE"}
            </button>
          </div>
        </div>

        {/* Controls row */}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            type="text"
            placeholder="Search name or traits…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{
              flex: 1,
              minWidth: 180,
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              color: "var(--rpc-text-primary)",
              padding: "7px 12px",
              borderRadius: 4,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          />
          <input
            type="text"
            placeholder="Max ETH"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            style={{
              width: 100,
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              color: "var(--rpc-text-primary)",
              padding: "7px 12px",
              borderRadius: 4,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
            }}
          />
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            style={{
              background: "var(--rpc-surface-raised)",
              border: "1px solid var(--rpc-border)",
              color: "var(--rpc-text-primary)",
              padding: "7px 12px",
              borderRadius: 4,
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              outline: "none",
              cursor: "pointer",
            }}
          >
            <option value="price-asc">Price: Low → High</option>
            <option value="price-desc">Price: High → Low</option>
            <option value="newest">Newest</option>
          </select>
        </div>
      </section>

      {/* ── Listings ── */}
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="rpc-card"
              style={{ padding: "14px 18px", display: "flex", gap: 14, alignItems: "center" }}
            >
              <div className="rpc-skeleton" style={{ width: 52, height: 52, borderRadius: 6, flexShrink: 0 }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="rpc-skeleton" style={{ width: "40%", height: 14 }} />
                <div className="rpc-skeleton" style={{ width: "25%", height: 10 }} />
              </div>
              <div className="rpc-skeleton" style={{ width: 80, height: 14 }} />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="rpc-card" style={{ padding: "32px 20px", textAlign: "center" }}>
          <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", marginBottom: 12 }}>
            Failed to load listings. The OpenSea API may be unavailable.
          </div>
          <button
            onClick={() => {
              setLoading(true)
              fetchListings()
            }}
            style={{
              background: ACCENT,
              color: "#000",
              border: "none",
              padding: "8px 20px",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rpc-card" style={{ padding: "32px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🃏</div>
          <div
            className="rpc-heading"
            style={{ fontSize: "var(--text-lg)", marginBottom: 8 }}
          >
            {listings.length === 0 ? "No Listings Found" : "No Matches"}
          </div>
          <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6, maxWidth: 480, margin: "0 auto" }}>
            {listings.length === 0
              ? "The Ethereum bridge just opened on March 30, 2026. Listings may take some time to appear as collectors bridge their cards. Check back soon!"
              : "No listings match your current filters. Try adjusting your search or max price."}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((listing) => {
            const player = listing.traits["Player"] ?? listing.name ?? "Unknown Card"
            const setName = listing.traits["Set Name"]
            const serial = listing.traits["Serial Number"]
            const circulation = listing.traits["Circulation Count"]
            const tier = listing.traits["Tier"]
            const sport = listing.traits["Sport"]

            return (
              <div
                key={listing.id}
                className="rpc-card"
                style={{
                  padding: "14px 18px",
                  display: "flex",
                  gap: 14,
                  alignItems: "center",
                }}
              >
                {/* Thumbnail */}
                <div
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 6,
                    background: "var(--rpc-surface-raised)",
                    border: "1px solid var(--rpc-border)",
                    overflow: "hidden",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {listing.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={listing.image_url}
                      alt={player}
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  ) : (
                    <span style={{ fontSize: 24 }}>🃏</span>
                  )}
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "var(--text-base)",
                      color: "var(--rpc-text-primary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {player}
                  </div>
                  <div
                    className="rpc-mono"
                    style={{
                      fontSize: "var(--text-xs)",
                      color: "var(--rpc-text-muted)",
                      marginTop: 2,
                      display: "flex",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {setName && <span>{setName}</span>}
                    {serial && circulation && <span>#{serial}/{circulation}</span>}
                    {serial && !circulation && <span>#{serial}</span>}
                    {tier && (
                      <span
                        style={{
                          color: tierColor(tier),
                          fontWeight: 700,
                        }}
                      >
                        {tier}
                      </span>
                    )}
                    {sport && <span>{sport}</span>}
                  </div>
                  <div
                    className="rpc-mono"
                    style={{
                      fontSize: 9,
                      color: "var(--rpc-text-ghost)",
                      marginTop: 2,
                    }}
                  >
                    {shortenAddress(listing.seller)} · {timeAgo(listing.listed_at)}
                  </div>
                </div>

                {/* Price */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div
                    className="rpc-heading"
                    style={{ fontSize: "var(--text-lg)", color: ACCENT }}
                  >
                    {listing.price_eth.toFixed(4)} ETH
                  </div>
                  {listing.price_usd != null && (
                    <div
                      className="rpc-mono"
                      style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}
                    >
                      ${listing.price_usd.toFixed(2)}
                    </div>
                  )}
                </div>

                {/* Buy button */}
                <a
                  href={listing.buy_url}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    background: ACCENT,
                    color: "#000",
                    padding: "6px 14px",
                    borderRadius: 4,
                    fontSize: 11,
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                    textDecoration: "none",
                    flexShrink: 0,
                    whiteSpace: "nowrap",
                  }}
                >
                  BUY →
                </a>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
