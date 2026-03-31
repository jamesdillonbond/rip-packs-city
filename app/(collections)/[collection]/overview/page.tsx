import { collectionPageMetadata } from "@/lib/seo"

export function generateMetadata({ params }: { params: { collection: string } }) {
  return collectionPageMetadata(params.collection, "overview")
}

"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketPulse {
  commonFloor?: number | null
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDollars(n: number) {
  if (n >= 1000) return "$" + (n / 1000).toFixed(1) + "k"
  return "$" + n.toFixed(2)
}

const TIER_COLORS: Record<string, string> = {
  legendary: "#F59E0B",
  rare:      "#818CF8",
  fandom:    "#34D399",
  common:    "#6B7280",
}
function tierColor(tier: string) {
  return TIER_COLORS[tier?.toLowerCase()] ?? "#6B7280"
}

const monoFont = "'Share Tech Mono', monospace"
const condensedFont = "'Barlow Condensed', sans-serif"

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  fontFamily: monoFont,
  letterSpacing: "0.2em",
  color: "rgba(255,255,255,0.4)",
  textTransform: "uppercase",
}

const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.02)",
  border: "1px solid rgba(255,255,255,0.07)",
  borderRadius: 10,
  padding: "16px 20px",
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
  const [pulseLoading, setPulseLoading] = useState(true)
  const [salesLoading, setSalesLoading] = useState(true)

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

  useEffect(() => {
    fetchPulse()
    fetchSales()
  }, [fetchPulse, fetchSales])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* Market Pulse */}
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#34D399", animation: "pulse 2s infinite" }} />
          <span style={labelStyle}>Market Pulse</span>
          <span style={{ marginLeft: "auto", fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.2)", letterSpacing: "0.1em" }}>60s cache · from RPC index</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {[
            { label: "Common Floor",     value: pulse?.commonFloor,     color: TIER_COLORS.common },
            { label: "Rare Floor",       value: pulse?.rareFloor,       color: TIER_COLORS.rare },
            { label: "Legendary Floor",  value: pulse?.legendaryFloor,  color: TIER_COLORS.legendary },
            { label: "Indexed Editions", value: pulse?.indexedEditions, color: "#34D399", isCount: true },
          ].map(({ label, value, color, isCount }) => (
            <div key={label}>
              <div style={{ fontSize: 8, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", marginBottom: 4, textTransform: "uppercase" }}>{label}</div>
              <div style={{ fontSize: 22, fontFamily: condensedFont, fontWeight: 800, color: pulseLoading ? "rgba(255,255,255,0.1)" : color, lineHeight: 1 }}>
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

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Platform News */}
        <section style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#E03A2F" }} />
            <span style={labelStyle}>Platform News</span>
            <a href="https://blog.nbatopshot.com" target="_blank" rel="noreferrer" style={{ marginLeft: "auto", fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textDecoration: "none" }}>blog →</a>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {TOP_SHOT_NEWS.map((item, i) => (
              <a key={i} href={item.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "10px 14px", cursor: "pointer" }}>
                  <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", marginBottom: 4 }}>
                    {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "#fff", letterSpacing: "0.02em", marginBottom: 4, lineHeight: 1.3 }}>{item.title}</div>
                  <div style={{ fontSize: 10, fontFamily: monoFont, color: "rgba(255,255,255,0.4)", lineHeight: 1.6 }}>{item.summary}</div>
                </div>
              </a>
            ))}
          </div>
        </section>

        {/* Recent Top Sales */}
        <section style={cardStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#F59E0B" }} />
            <span style={labelStyle}>Recent Top Sales</span>
            <Link href="/nba-top-shot/sniper" style={{ marginLeft: "auto", fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em", textDecoration: "none" }}>sniper →</Link>
          </div>
          {salesLoading ? (
            <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, fontFamily: monoFont, padding: "16px 0", textAlign: "center" }}>Loading…</div>
          ) : topSales.length === 0 ? (
            <div style={{ color: "rgba(255,255,255,0.25)", fontSize: 10, fontFamily: monoFont, padding: "16px 0", textAlign: "center" }}>No recent sales data</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topSales.map((sale, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "8px 12px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 6, alignItems: "center" }}>
                  <div>
                    <div style={{ fontFamily: condensedFont, fontWeight: 700, fontSize: 13, color: "#fff", letterSpacing: "0.02em" }}>{sale.playerName}</div>
                    <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)", marginTop: 2 }}>
                      {sale.setName} · #{sale.serialNumber}/{sale.circulationCount}
                      {" · "}
                      <span style={{ color: tierColor(sale.tier) }}>{sale.tier}</span>
                    </div>
                  </div>
                  <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 16, color: "#34D399", textAlign: "right" }}>{fmtDollars(sale.price)}</div>
                </div>
              ))}
            </div>
          )}
        </section>

      </div>

      {/* Quick Links */}
      <section style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "rgba(255,255,255,0.3)" }} />
          <span style={labelStyle}>Tools</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10 }}>
          {[
            { label: "Collection",   desc: "FMV · Flowty asks · badge intel", icon: "◈", color: "#E03A2F", page: "collection" },
            { label: "Pack EV",      desc: "Expected value vs price",          icon: "▣", color: "#F59E0B", page: "packs"      },
            { label: "Sniper",       desc: "Real-time deals below FMV",        icon: "⚡", color: "#34D399", page: "sniper"     },
            { label: "Badges",       desc: "Debut · Fresh · Rookie Year",      icon: "⭐", color: "#818CF8", page: "badges"     },
            { label: "Sets",         desc: "Completion + bottleneck finder",   icon: "◉", color: "#F472B6", page: "sets"       },
          ].map(({ label, desc, icon, color, page }) => (
            <Link key={page} href={`/nba-top-shot/${page}`} style={{ textDecoration: "none" }}>
              <div style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 8, padding: "14px 16px", cursor: "pointer", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: color, opacity: 0.5 }} />
                <div style={{ fontSize: 18, marginBottom: 7, color }}>{icon}</div>
                <div style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 13, color: "#fff", letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
                <div style={{ fontSize: 9, fontFamily: monoFont, color: "rgba(255,255,255,0.35)" }}>{desc}</div>
              </div>
            </Link>
          ))}
        </div>
      </section>

    </div>
  )
}