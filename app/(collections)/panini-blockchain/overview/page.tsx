"use client"

import { useEffect, useState, useCallback } from "react"
import Link from "next/link"

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketStats {
  floor_price: number | null
  floor_price_symbol: string
  total_volume: number | null
  total_sales: number | null
  num_owners: number | null
  total_supply: number | null
  updated_at: string | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtEth(n: number | null) {
  if (n == null) return "—"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k ETH"
  if (n >= 1) return n.toFixed(2) + " ETH"
  return n.toFixed(4) + " ETH"
}

function fmtNum(n: number | null) {
  if (n == null) return "—"
  return n.toLocaleString()
}

// ── Static data ──────────────────────────────────────────────────────────────

const PANINI_NEWS = [
  {
    title: "Ethereum Bridge Opens — Panini Cards Now On-Chain",
    date: "2026-03-30",
    summary: "Panini America officially opens the Ethereum bridge, allowing collectors to move their digital cards on-chain and trade on OpenSea.",
  },
  {
    title: "Panini Announces Blockchain-to-Ethereum Bridge",
    date: "2025-09-15",
    summary: "Panini America reveals plans to bridge digital trading cards to Ethereum, partnering with OpenSea for secondary market trading.",
  },
  {
    title: "Record Digital Sales Month for Panini Blockchain",
    date: "2025-10-20",
    summary: "October 2025 marks the highest-ever monthly sales volume on the Panini Blockchain platform, driven by NBA and NFL season openers.",
  },
]

const BRIDGE_STEPS = [
  { step: "1", title: "Bridge to Ethereum", desc: "Connect your Panini wallet and select cards to bridge. They become ERC-721 NFTs on Ethereum." },
  { step: "2", title: "Trade on OpenSea", desc: "Bridged cards appear in your Ethereum wallet and are instantly tradeable on OpenSea." },
  { step: "3", title: "Bridge Back Anytime", desc: "Return cards to the Panini platform whenever you want — bridging is fully reversible." },
]

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaniniOverviewPage() {
  const [stats, setStats] = useState<MarketStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState(false)

  const fetchStats = useCallback(async () => {
    try {
      setStatsError(false)
      const res = await fetch("/api/panini/market-stats")
      if (!res.ok) throw new Error("Failed to fetch")
      setStats(await res.json())
    } catch {
      setStatsError(true)
    } finally {
      setStatsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchStats()
  }, [fetchStats])

  const accent = "#C084FC"

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Bridge Announcement Banner ── */}
      <section className="rpc-card" style={{ padding: "32px 24px", textAlign: "center", border: `1px solid ${accent}44`, position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 16 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: accent, animation: "pulse 2s infinite" }} />
          <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: accent, letterSpacing: "0.15em", fontWeight: 700 }}>
            BRIDGE LIVE — MARCH 30, 2026
          </span>
        </div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: "var(--text-2xl, 28px)", color: "var(--rpc-text-primary)", letterSpacing: "0.04em", marginBottom: 12, textTransform: "uppercase" }}>
          Panini Cards Are Now on Ethereum
        </div>
        <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", maxWidth: 640, margin: "0 auto 20px", lineHeight: 1.7 }}>
          Panini America has officially opened the Ethereum bridge for their digital trading cards.
          Collectors can now move cards on-chain and trade freely on OpenSea. Rip Packs City is building
          real-time market intelligence tools — starting with a live sniper feed for bridged card listings.
        </div>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <a
            href="https://opensea.io/collection/paniniblockchain"
            target="_blank"
            rel="noreferrer"
            style={{ padding: "10px 24px", background: accent, border: "none", borderRadius: "var(--radius-sm)", color: "#fff", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-sm)", letterSpacing: "0.04em", textDecoration: "none", textTransform: "uppercase" }}
          >
            View on OpenSea →
          </a>
          <a
            href="https://nft.paniniamerica.net"
            target="_blank"
            rel="noreferrer"
            style={{ padding: "10px 24px", background: "transparent", border: `1px solid ${accent}66`, borderRadius: "var(--radius-sm)", color: accent, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-sm)", letterSpacing: "0.04em", textDecoration: "none", textTransform: "uppercase" }}
          >
            Panini Marketplace →
          </a>
        </div>
      </section>

      {/* ── Market Stats ── */}
      <section style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { label: "Floor Price", value: statsLoading ? null : stats?.floor_price, fmt: fmtEth },
          { label: "Total Volume", value: statsLoading ? null : stats?.total_volume, fmt: fmtEth },
          { label: "Unique Owners", value: statsLoading ? null : stats?.num_owners, fmt: fmtNum },
          { label: "Cards On-Chain", value: statsLoading ? null : stats?.total_supply, fmt: fmtNum },
        ].map(({ label, value, fmt }) => (
          <div key={label} className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.5 }} />
            <div className="rpc-label" style={{ marginBottom: 6 }}>{label}</div>
            {statsLoading ? (
              <div className="rpc-skeleton" style={{ width: "60%", height: 20 }} />
            ) : statsError ? (
              <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)" }}>—</div>
            ) : (
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: accent }}>
                {fmt(value ?? null)}
              </div>
            )}
          </div>
        ))}
      </section>

      {/* ── How the Bridge Works + Platform News ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* How the Bridge Works */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">How the Bridge Works</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {BRIDGE_STEPS.map((s) => (
              <div key={s.step} className="rpc-card" style={{ padding: "12px 16px", display: "flex", gap: 14, alignItems: "flex-start" }}>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${accent}22`, border: `1px solid ${accent}44`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-sm)", color: accent }}>
                  {s.step}
                </div>
                <div>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)", marginBottom: 2 }}>{s.title}</div>
                  <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Platform News */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">Platform News</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {PANINI_NEWS.map((item, i) => (
              <div key={i} className="rpc-card" style={{ padding: "10px 14px" }}>
                <div className="rpc-label" style={{ marginBottom: 4 }}>
                  {new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)", letterSpacing: "0.02em", marginBottom: 4, lineHeight: 1.3 }}>{item.title}</div>
                <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>{item.summary}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── RPC Intelligence Tools ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
          <span className="rpc-label">RPC Intelligence</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            { label: "Sniper", desc: "Live OpenSea floor + listings below value", icon: "⚡", status: "LIVE", href: "/panini-blockchain/sniper", live: true },
            { label: "Wallet Analyzer", desc: "Portfolio value for bridged Panini cards", icon: "◈", status: "COMING SOON", href: null, live: false },
            { label: "Pack EV", desc: "Expected value calculator for Panini packs", icon: "▣", status: "COMING SOON", href: null, live: false },
          ].map((tool) => {
            const inner = (
              <div className="rpc-card" style={{ padding: "14px 16px", cursor: tool.live ? "pointer" : "default", position: "relative", overflow: "hidden", opacity: tool.live ? 1 : 0.6 }}>
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.5 }} />
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                  <span style={{ fontSize: 18, color: accent }}>{tool.icon}</span>
                  <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: tool.live ? "var(--rpc-success)" : "var(--rpc-text-ghost)", letterSpacing: "0.1em", fontWeight: 700 }}>{tool.status}</span>
                </div>
                <div className="rpc-heading" style={{ fontSize: "var(--text-base)", marginBottom: 3 }}>{tool.label}</div>
                <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{tool.desc}</div>
              </div>
            )
            return tool.href ? (
              <Link key={tool.label} href={tool.href} style={{ textDecoration: "none" }}>{inner}</Link>
            ) : (
              <div key={tool.label}>{inner}</div>
            )
          })}
        </div>
      </section>

      {/* ── About ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-text-muted)" }} />
          <span className="rpc-label">About Panini Blockchain</span>
        </div>
        <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", lineHeight: 1.7, marginBottom: 16 }}>
          Panini Blockchain is Panini America&apos;s digital trading card platform featuring officially licensed NBA, NFL, FIFA, WNBA, and NASCAR cards.
          With the March 2026 Ethereum bridge, collectors can now move cards on-chain as ERC-721 NFTs and trade on OpenSea — opening up Panini&apos;s catalog to the broader crypto collectibles market.
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {[
            { label: "Panini Marketplace", href: "https://nft.paniniamerica.net" },
            { label: "OpenSea", href: "https://opensea.io/collection/paniniblockchain" },
            { label: "Panini Blog", href: "https://blog.paniniamerica.net" },
            { label: "CryptoSlam", href: "https://www.cryptoslam.io/panini-blockchain" },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noreferrer"
              className="rpc-mono"
              style={{ fontSize: "var(--text-xs)", color: accent, textDecoration: "none", padding: "4px 10px", border: `1px solid ${accent}44`, borderRadius: "var(--radius-sm)", letterSpacing: "0.04em" }}
            >
              {link.label} ↗
            </a>
          ))}
        </div>
      </section>

    </div>
  )
}
