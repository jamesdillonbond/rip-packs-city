"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketPulse {
  commonFloor?: number | null
  fandomFloor?: number | null
  rareFloor?: number | null
  legendaryFloor?: number | null
  indexedEditions?: number
}

interface TopSale {
  playerName: string
  setName: string
  serialNumber: number
  circulationCount: number
  price: number
  tier: string
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
  lastIngest?: string
  fmvFreshness?: string
  totalEditions?: number
  status?: string
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

// ── Static news items ─────────────────────────────────────────────────────────

const TOP_SHOT_NEWS = [
  {
    title: "All-Star 2026 LA Takeover — $17,500 Top Sale",
    date: "2026-02-07",
    summary: "Top Shot partnered with Baron Davis for an All-Star event while a Legendary Steph Curry Moment set the 2026 high-water mark.",
    url: "https://blog.nbatopshot.com",
  },
  {
    title: "2025-26: Scarcity-First Drops & New Parallel System",
    date: "2026-01-15",
    summary: "Dapper shifts to lower-print-run releases with redesigned parallels. LAVA tools integration now live for FMV transparency.",
    url: "https://blog.nbatopshot.com",
  },
  {
    title: "Top Shot This (TST) — Real-Time Minting from Live Games",
    date: "2026-01-10",
    summary: "Best dunks and moments now minted within 24 hours and delivered to fans directly after each game.",
    url: "https://blog.nbatopshot.com",
  },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const [pulse, setPulse] = useState<MarketPulse | null>(null)
  const [topSales, setTopSales] = useState<TopSale[]>([])
  const [sniperDeals, setSniperDeals] = useState<SniperDealPreview[]>([])
  const [health, setHealth] = useState<HealthData | null>(null)
  const [pulseLoading, setPulseLoading] = useState(true)
  const [salesLoading, setSalesLoading] = useState(true)
  const [sniperLoading, setSniperLoading] = useState(true)

  const fetchPulse = useCallback(async () => {
    try {
      const res = await fetch("/api/profile/market-pulse", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      setPulse(data)
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

  const fetchSniper = useCallback(async () => {
    try {
      const res = await fetch("/api/sniper-feed?sortBy=discount&limit=5", { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.deals)) setSniperDeals(data.deals.slice(0, 5))
    } catch { /* swallow */ } finally {
      setSniperLoading(false)
    }
  }, [])

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Market Pulse */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-success)", animation: "pulse 2s infinite" }} />
          <span className="rpc-label">Market Pulse</span>
          <span className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>60s cache · from RPC index</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 16 }}>
          {[
            { label: "Common Floor",     value: pulse?.commonFloor,     color: TIER_COLORS.common },
            { label: "Fandom Floor",     value: pulse?.fandomFloor,     color: TIER_COLORS.fandom },
            { label: "Rare Floor",       value: pulse?.rareFloor,       color: TIER_COLORS.rare },
            { label: "Legendary Floor",  value: pulse?.legendaryFloor,  color: TIER_COLORS.legendary },
            { label: "Indexed Editions", value: pulse?.indexedEditions, color: "var(--rpc-success)", isCount: true },
          ].map(({ label, value, color, isCount }) => (
            <div key={label} className="rpc-card" style={{ padding: "12px 14px", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.7 }} />
              <div className="rpc-label" style={{ marginBottom: 4 }}>{label}</div>
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: pulseLoading ? "var(--rpc-text-ghost)" : color }}>
                {pulseLoading
                  ? "—"
                  : value != null
                    ? isCount
                      ? Number(value).toLocaleString()
                      : fmtDollars(Number(value))
                    : "—"}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Top Sniper Deals + Pipeline Health */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Top Sniper Deals */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-red)" }} />
            <span className="rpc-label">Top Sniper Deals</span>
            <Link href="/nba-top-shot/sniper" className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>View all →</Link>
          </div>
          {sniperLoading ? (
            <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              {[100, 80, 60].map((w, i) => (
                <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, height: 12 }} />
              ))}
            </div>
          ) : sniperDeals.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>No deals available</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sniperDeals.map((deal) => (
                <div key={deal.flowId} style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 12, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center" }}>
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

        {/* Recent Top Sales */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--tier-legendary)" }} />
            <span className="rpc-label">Recent Top Sales</span>
            <Link href="/nba-top-shot/sniper" className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>sniper →</Link>
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
                      {sale.setName} · #{sale.serialNumber}/{sale.circulationCount}
                      {" · "}
                      <span style={{ color: tierColor(sale.tier) }}>{sale.tier}</span>
                    </div>
                  </div>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", color: "var(--rpc-success)", textAlign: "right" }}>{fmtDollars(sale.price)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* Pipeline Health + Platform News */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Pipeline Health */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: health?.status === "ok" ? "var(--rpc-success)" : "var(--rpc-warning)", animation: "pulse 2s infinite" }} />
            <span className="rpc-label">Pipeline Health</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12 }}>
            {[
              { label: "Last Ingest", value: health?.lastIngest ? new Date(health.lastIngest).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—" },
              { label: "FMV Freshness", value: health?.fmvFreshness ?? "—" },
              { label: "Total Editions", value: health?.totalEditions?.toLocaleString() ?? "—" },
            ].map(({ label, value }) => (
              <div key={label}>
                <div className="rpc-label" style={{ marginBottom: 4 }}>{label}</div>
                <div className="rpc-mono" style={{ color: "var(--rpc-text-primary)", fontSize: "var(--text-base)" }}>{value}</div>
              </div>
            ))}
          </div>
        </section>

        {/* Platform News */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-red)" }} />
            <span className="rpc-label">Platform News</span>
            <a href="https://blog.nbatopshot.com" target="_blank" rel="noreferrer" className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>blog →</a>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {TOP_SHOT_NEWS.map((item, i) => (
              <a key={i} href={item.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <div className="rpc-card" style={{ padding: "10px 14px", cursor: "pointer" }}>
                  <div className="rpc-label" style={{ marginBottom: 4 }}>
                    {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)", letterSpacing: "0.02em", marginBottom: 4, lineHeight: 1.3 }}>{item.title}</div>
                  <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>{item.summary}</div>
                </div>
              </a>
            ))}
          </div>
        </section>

      </div>

      {/* Quick Links */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-text-muted)" }} />
          <span className="rpc-label">Tools</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
          {[
            { label: "Collection",   desc: "FMV · Flowty asks · badge intel", icon: "◈", color: "var(--rpc-red)", page: "collection" },
            { label: "Pack EV",      desc: "Expected value vs price",          icon: "▣", color: "var(--tier-legendary)", page: "packs" },
            { label: "Sniper",       desc: "Real-time deals below FMV",        icon: "⚡", color: "var(--rpc-success)", page: "sniper" },
            { label: "Badges",       desc: "Debut · Fresh · Rookie Year",      icon: "⭐", color: "var(--tier-rare)", page: "badges" },
            { label: "Sets",         desc: "Completion + bottleneck finder",   icon: "◉", color: "#F472B6", page: "sets" },
          ].map(({ label, desc, icon, color, page }) => (
            <Link key={page} href={`/nba-top-shot/${page}`} style={{ textDecoration: "none" }}>
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
