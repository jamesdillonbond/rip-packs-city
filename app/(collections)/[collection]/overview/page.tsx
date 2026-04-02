"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams } from "next/navigation"
import Link from "next/link"

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketPulseData {
  marketPulse: string | null
  dailyDeal: {
    player_name: string
    tier: string
    set_name: string
    low_ask: number
    fmv: number
    discount_pct: number
    badges: string[]
  } | null
}

interface SniperDealPreview {
  flowId: string
  playerName: string
  tier: string
  askPrice: number
  discount: number
  source?: string
}

interface HealthData {
  fmv_pipeline?: {
    is_stale: boolean
    latest_fmv_at: string | null
    minutes_since_last_fmv: number | null
  }
  data_integrity?: {
    orphaned_editions_ok: boolean
  }
  status?: string
  [key: string]: unknown
}

interface TopSale {
  playerName: string
  setName: string
  serialNumber: number
  circulationCount: number
  price: number
  tier: string
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDollars(n: number) {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k"
  return "$" + n.toFixed(2)
}

const TIER_COLORS: Record<string, string> = {
  legendary: "var(--tier-legendary)",
  rare:      "var(--tier-rare)",
  fandom:    "var(--tier-fandom)",
  common:    "var(--tier-common)",
  ultimate:  "var(--tier-ultimate)",
}
function tierColor(tier: string) {
  return TIER_COLORS[tier?.toLowerCase()] ?? "var(--tier-common)"
}

// Pipeline freshness: green < 30min, yellow 30-60min, red > 60min
function freshnessIndicator(minutes: number | null): { color: string; label: string } {
  if (minutes == null) return { color: "var(--rpc-text-ghost)", label: "UNKNOWN" }
  if (minutes <= 30) return { color: "var(--rpc-success)", label: "FRESH" }
  if (minutes <= 60) return { color: "var(--rpc-warning, #F59E0B)", label: "STALE" }
  return { color: "var(--rpc-danger)", label: "OUTDATED" }
}

// ── About the Community content ──────────────────────────────────────────────

const COMMUNITY_BLOCKS = [
  {
    heading: "Built for Collectors, By Collectors",
    body: "Rip Packs City started as a tool for the Portland Trail Blazers community on NBA Top Shot — collectors who care about getting real value from their moments, not just chasing hype. That same obsession with data and fairness drives everything here.",
  },
  {
    heading: "The Top Shot Ecosystem",
    body: "NBA Top Shot has traded over $1 billion in moments since 2020. Behind those numbers is a global community of collectors who track serial numbers, chase badge premiums, complete sets, and hunt deals across multiple marketplaces. RPC gives that community the intelligence layer it deserves — FMV that reflects real sales, not ask prices.",
  },
  {
    heading: "Digital Collectibles, Broadly",
    body: "The tools and principles here — fair market value, scarcity analysis, badge premiums, set completion — apply across digital collectibles. Whether it\u2019s Top Shot, NFL All Day, or what comes next, collectors deserve transparent data and real intelligence, not guesswork.",
  },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const params = useParams()
  const collection = (params?.collection as string) ?? "nba-top-shot"

  const [pulseData, setPulseData] = useState<MarketPulseData | null>(null)
  const [topSales, setTopSales] = useState<TopSale[]>([])
  const [sniperDeals, setSniperDeals] = useState<SniperDealPreview[]>([])
  const [health, setHealth] = useState<HealthData | null>(null)
  const [pulseLoading, setPulseLoading] = useState(true)
  const [salesLoading, setSalesLoading] = useState(true)
  const [sniperLoading, setSniperLoading] = useState(true)

  // Fetch market pulse from the concierge context API
  const fetchPulse = useCallback(async () => {
    try {
      const res = await fetch("/api/support-chat/context", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      setPulseData({
        marketPulse: data.marketPulse ?? null,
        dailyDeal: data.dailyDeal ?? null,
      })
    } catch { /* swallow */ } finally {
      setPulseLoading(false)
    }
  }, [])

  const fetchSales = useCallback(async () => {
    try {
      const res = await fetch("/api/edition-sales?limit=5")
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.sales)) setTopSales(data.sales)
      else if (Array.isArray(data)) setTopSales(data.slice(0, 5))
    } catch { /* swallow */ } finally {
      setSalesLoading(false)
    }
  }, [])

  // Fetch top 5 sniper deals with minDiscount=15
  const fetchSniper = useCallback(async () => {
    try {
      const res = await fetch("/api/sniper-feed?limit=5&minDiscount=15", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.deals)) setSniperDeals(data.deals.slice(0, 5))
    } catch { /* swallow */ } finally {
      setSniperLoading(false)
    }
  }, [])

  // Fetch pipeline health for freshness indicator
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" })
      if (!res.ok) return
      setHealth(await res.json())
    } catch { /* swallow */ }
  }, [])

  useEffect(() => {
    fetchPulse()
    fetchSales()
    fetchSniper()
    fetchHealth()
  }, [fetchPulse, fetchSales, fetchSniper, fetchHealth])

  // Derive pipeline freshness
  const fmvMinutes = health?.fmv_pipeline?.minutes_since_last_fmv ?? null
  const freshness = freshnessIndicator(fmvMinutes)
  const basePath = "/" + collection

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Market Summary (from concierge context) ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-success)", animation: "pulse 2s infinite" }} />
          <span className="rpc-label">Market Summary</span>
          <span className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>5 min cache &middot; concierge context</span>
        </div>

        {/* Market pulse text */}
        <div style={{ marginBottom: 16 }}>
          {pulseLoading ? (
            <div className="rpc-skeleton" style={{ width: "60%", height: 14 }} />
          ) : pulseData?.marketPulse ? (
            <div className="rpc-mono" style={{ fontSize: "var(--text-base)", color: "var(--rpc-text-primary)", letterSpacing: "0.02em" }}>
              {pulseData.marketPulse}
            </div>
          ) : (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)" }}>No market data available</div>
          )}
        </div>

        {/* Daily deal highlight */}
        {pulseData?.dailyDeal && (
          <div className="rpc-card" style={{ padding: "12px 16px", display: "grid", gridTemplateColumns: "1fr auto", gap: 16, alignItems: "center" }}>
            <div>
              <div className="rpc-label" style={{ marginBottom: 4 }}>TOP DEAL RIGHT NOW</div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-lg)", color: "var(--rpc-text-primary)" }}>
                {pulseData.dailyDeal.player_name}
              </div>
              <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginTop: 2 }}>
                {pulseData.dailyDeal.set_name} &middot;{" "}
                <span style={{ color: tierColor(pulseData.dailyDeal.tier) }}>{pulseData.dailyDeal.tier}</span>
                {pulseData.dailyDeal.badges.length > 0 && (
                  <span> &middot; {pulseData.dailyDeal.badges.slice(0, 2).join(", ")}</span>
                )}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-xl)", color: "var(--rpc-success)" }}>
                {fmtDollars(pulseData.dailyDeal.low_ask)}
              </div>
              <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
                FMV {fmtDollars(pulseData.dailyDeal.fmv)}
              </div>
              <div className="rpc-mono" style={{ fontSize: "var(--text-sm)", color: "var(--rpc-danger)", fontWeight: 700 }}>
                -{pulseData.dailyDeal.discount_pct}%
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Top Sniper Deals + Pipeline Health ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Top Sniper Deals (minDiscount=15) */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-red)" }} />
            <span className="rpc-label">Top 5 Sniper Deals ({"\u2265"}15% off)</span>
            <Link href={basePath + "/sniper"} className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>View all {"\u2192"}</Link>
          </div>
          {sniperLoading ? (
            <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              {[100, 80, 60].map((w, i) => (
                <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, height: 12 }} />
              ))}
            </div>
          ) : sniperDeals.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>No deals {"\u2265"}15% discount right now</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sniperDeals.map((deal, i) => (
                <div key={deal.flowId ?? i} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center" }}>
                  <div>
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)" }}>{deal.playerName}</div>
                    <div className="rpc-mono" style={{ color: tierColor(deal.tier), fontSize: "var(--text-xs)" }}>{deal.tier}</div>
                  </div>
                  <div className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>{fmtDollars(deal.askPrice)}</div>
                  <div className="rpc-mono" style={{ color: "var(--rpc-danger)", fontWeight: 700 }}>-{deal.discount.toFixed(1)}%</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Pipeline Health + Freshness Indicator */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: freshness.color, animation: "pulse 2s infinite", border: "1px solid " + freshness.color }} />
            <span className="rpc-label">Pipeline Status</span>
            <span className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: freshness.color, fontWeight: 700, letterSpacing: "0.1em" }}>{freshness.label}</span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 12, marginBottom: 16 }}>
            <div className="rpc-card" style={{ padding: "12px 14px", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: freshness.color, opacity: 0.7 }} />
              <div className="rpc-label" style={{ marginBottom: 4 }}>FMV Data Age</div>
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: freshness.color }}>
                {fmvMinutes != null ? fmvMinutes + " min" : "\u2014"}
              </div>
            </div>
            <div className="rpc-card" style={{ padding: "12px 14px", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: health?.status === "ok" ? "var(--rpc-success)" : "var(--rpc-warning, #F59E0B)", opacity: 0.7 }} />
              <div className="rpc-label" style={{ marginBottom: 4 }}>System Status</div>
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: health?.status === "ok" ? "var(--rpc-success)" : "var(--rpc-warning, #F59E0B)" }}>
                {health?.status?.toUpperCase() ?? "\u2014"}
              </div>
            </div>
          </div>

          {/* Freshness legend */}
          <div style={{ display: "flex", gap: 16, justifyContent: "center" }}>
            {[
              { color: "var(--rpc-success)", label: "< 30 min" },
              { color: "var(--rpc-warning, #F59E0B)", label: "30\u201360 min" },
              { color: "var(--rpc-danger)", label: "> 60 min" },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: item.color }} />
                <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Recent Top Sales + Platform News ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Recent Top Sales */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--tier-legendary)" }} />
            <span className="rpc-label">Recent Top Sales</span>
            <Link href={basePath + "/sniper"} className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>sniper {"\u2192"}</Link>
          </div>
          {salesLoading ? (
            <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              {[100, 80, 60].map((w, i) => (
                <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, height: 12 }} />
              ))}
            </div>
          ) : topSales.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>No recent sales data</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topSales.map((sale, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center" }}>
                  <div>
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)" }}>{sale.playerName}</div>
                    <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginTop: 2 }}>
                      {sale.setName} &middot; #{sale.serialNumber}/{sale.circulationCount}
                      {" \u00b7 "}
                      <span style={{ color: tierColor(sale.tier) }}>{sale.tier}</span>
                    </div>
                  </div>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", color: "var(--rpc-success)", textAlign: "right" }}>{fmtDollars(sale.price)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* About the Community */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-red)" }} />
            <span className="rpc-label">About the Community</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {COMMUNITY_BLOCKS.map((block, i) => (
              <div key={i} style={{
                padding: "16px 0",
                borderTop: i > 0 ? "1px solid var(--rpc-border)" : "none",
              }}>
                <div style={{
                  fontSize: "var(--text-base)",
                  fontFamily: "var(--font-display)",
                  fontWeight: 700,
                  color: "var(--rpc-text-primary)",
                  letterSpacing: "0.03em",
                  marginBottom: 6,
                }}>{block.heading}</div>
                <div style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-xs)",
                  color: "var(--rpc-text-muted)",
                  lineHeight: 1.7,
                  opacity: 0.85,
                }}>{block.body}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Quick Nav Cards ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-text-muted)" }} />
          <span className="rpc-label">Tools</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
          {[
            { label: "Collection",   desc: "FMV \u00b7 Flowty asks \u00b7 badge intel", icon: "\u25C8", color: "var(--rpc-red)", page: "collection" },
            { label: "Pack EV",      desc: "Expected value vs price",                    icon: "\u25A3", color: "var(--tier-legendary)", page: "packs" },
            { label: "Sniper",       desc: "Real-time deals below FMV",                  icon: "\u26A1", color: "var(--rpc-success)", page: "sniper" },
            { label: "Badges",       desc: "Debut \u00b7 Fresh \u00b7 Rookie Year",      icon: "\u2B50", color: "var(--tier-rare)", page: "badges" },
            { label: "Sets",         desc: "Completion + bottleneck finder",              icon: "\u25C9", color: "#F472B6", page: "sets" },
          ].map(({ label, desc, icon, color, page }) => (
            <Link key={page} href={basePath + "/" + page} style={{ textDecoration: "none" }}>
              <div className="rpc-card" style={{ padding: "14px 16px", cursor: "pointer", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.5 }} />
                <div style={{ fontSize: 18, marginBottom: 7, color }}>{icon}</div>
                <div className="rpc-heading" style={{ fontSize: "var(--text-base)", marginBottom: 3 }}>{label}</div>
                <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

    </div>
  )
}
