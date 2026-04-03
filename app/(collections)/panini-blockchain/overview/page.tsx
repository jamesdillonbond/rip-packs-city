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
  updated_at: string
}

// ── Static data ───────────────────────────────────────────────────────────────

const PANINI_NEWS = [
  {
    title: "Ethereum Bridge Goes Live",
    date: "2026-03-30",
    summary:
      "Panini Blockchain cards can now be bridged to Ethereum and traded on OpenSea. The bridge supports all sports: basketball, football, soccer, WNBA, and racing.",
  },
  {
    title: "Bridge Announcement & Roadmap",
    date: "2025-09-15",
    summary:
      "Panini America announces partnership with Immutable to bring digital trading cards to Ethereum via a trustless bridge, with full metadata preservation.",
  },
  {
    title: "Record Sales Month for Digital Panini",
    date: "2025-10-20",
    summary:
      "October 2025 sees the highest monthly volume for Panini Blockchain cards since launch, driven by NFL and NBA season openers.",
  },
]

const BRIDGE_STEPS = [
  {
    step: 1,
    title: "Bridge to Ethereum",
    desc: "Connect your Panini wallet and select cards to bridge. Cards are locked on Panini Chain and minted as ERC-721 tokens on Ethereum.",
  },
  {
    step: 2,
    title: "Trade on OpenSea",
    desc: "Bridged cards appear in your Ethereum wallet and are listed on OpenSea with full metadata, traits, and images intact.",
  },
  {
    step: 3,
    title: "Bridge Back Anytime",
    desc: "Return cards to Panini Chain whenever you want. The Ethereum token is burned and the original card is unlocked on Panini.",
  },
]

const EXTERNAL_LINKS = [
  { label: "Panini Marketplace", url: "https://nft.paniniamerica.net" },
  { label: "OpenSea Collection", url: "https://opensea.io/collection/paniniblockchain" },
  { label: "Panini Blog", url: "https://blog.paniniamerica.net" },
  { label: "CryptoSlam", url: "https://cryptoslam.io" },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtEth(n: number | null) {
  if (n == null) return "—"
  if (n >= 1000) return (n / 1000).toFixed(1) + "k ETH"
  if (n >= 1) return n.toFixed(2) + " ETH"
  return n.toFixed(4) + " ETH"
}

function fmtNumber(n: number | null) {
  if (n == null) return "—"
  return n.toLocaleString()
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PaniniOverviewPage() {
  const [stats, setStats] = useState<MarketStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState(false)

  const fetchStats = useCallback(async () => {
    try {
      setStatsError(false)
      const res = await fetch("/api/panini/market-stats")
      if (!res.ok) throw new Error("fetch failed")
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

  const ACCENT = "#C084FC"

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Bridge Announcement Banner ── */}
      <section
        className="rpc-card"
        style={{
          padding: "24px 28px",
          background: `linear-gradient(135deg, rgba(192,132,252,0.12) 0%, rgba(192,132,252,0.04) 100%)`,
          border: `1px solid ${ACCENT}44`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: ACCENT,
              animation: "pulse 2s infinite",
            }}
          />
          <span
            className="rpc-mono"
            style={{
              fontSize: "var(--text-xs)",
              color: ACCENT,
              letterSpacing: "0.15em",
              fontWeight: 700,
            }}
          >
            BRIDGE LIVE — MARCH 30, 2026
          </span>
        </div>

        <h2
          className="rpc-heading"
          style={{
            fontSize: "var(--text-2xl, 24px)",
            marginBottom: 12,
            color: "var(--rpc-text-primary)",
          }}
        >
          Panini Cards Are Now on Ethereum
        </h2>

        <p
          className="rpc-mono"
          style={{
            color: "var(--rpc-text-muted)",
            lineHeight: 1.7,
            maxWidth: 720,
            marginBottom: 20,
          }}
        >
          The Panini Blockchain Ethereum bridge is live. Collectors can now bridge their digital
          trading cards to Ethereum and trade them on OpenSea — basketball, football, soccer, WNBA,
          and racing. Rip Packs City is building live market intelligence, a sniper tool for floor
          deals, and wallet analytics for bridged cards.
        </p>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <a
            href="https://opensea.io/collection/paniniblockchain"
            target="_blank"
            rel="noreferrer"
            style={{
              background: ACCENT,
              color: "#000",
              padding: "8px 20px",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              textDecoration: "none",
            }}
          >
            View on OpenSea →
          </a>
          <a
            href="https://nft.paniniamerica.net"
            target="_blank"
            rel="noreferrer"
            style={{
              background: "transparent",
              color: ACCENT,
              padding: "8px 20px",
              borderRadius: 6,
              fontSize: 12,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              textDecoration: "none",
              border: `1px solid ${ACCENT}66`,
            }}
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
          { label: "Unique Owners", value: statsLoading ? null : stats?.num_owners, fmt: fmtNumber },
          { label: "Cards On-Chain", value: statsLoading ? null : stats?.total_supply, fmt: fmtNumber },
        ].map(({ label, value, fmt }) => (
          <div
            key={label}
            className="rpc-card"
            style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                height: 2,
                background: ACCENT,
                opacity: 0.5,
              }}
            />
            <div className="rpc-label" style={{ marginBottom: 6 }}>
              {label}
            </div>
            {statsLoading ? (
              <div className="rpc-skeleton" style={{ width: "60%", height: 20 }} />
            ) : statsError ? (
              <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)" }}>—</div>
            ) : (
              <div
                className="rpc-heading"
                style={{ fontSize: "var(--text-xl)", color: ACCENT }}
              >
                {fmt(value ?? null)}
              </div>
            )}
          </div>
        ))}
      </section>

      {/* ── Bridge Steps + News ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        {/* How the Bridge Works */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: ACCENT }} />
            <span className="rpc-label">How the Bridge Works</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {BRIDGE_STEPS.map((s) => (
              <div
                key={s.step}
                className="rpc-card"
                style={{ padding: "12px 16px", display: "flex", gap: 14, alignItems: "flex-start" }}
              >
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: `${ACCENT}22`,
                    border: `1px solid ${ACCENT}55`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontFamily: "var(--font-mono)",
                    color: ACCENT,
                    fontWeight: 700,
                    flexShrink: 0,
                  }}
                >
                  {s.step}
                </div>
                <div>
                  <div
                    style={{
                      fontFamily: "var(--font-display)",
                      fontWeight: 700,
                      fontSize: "var(--text-base)",
                      color: "var(--rpc-text-primary)",
                      marginBottom: 4,
                    }}
                  >
                    {s.title}
                  </div>
                  <div
                    className="rpc-mono"
                    style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6 }}
                  >
                    {s.desc}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Platform News */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: ACCENT }} />
            <span className="rpc-label">Platform News</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {PANINI_NEWS.map((item, i) => (
              <div key={i} className="rpc-card" style={{ padding: "10px 14px" }}>
                <div className="rpc-label" style={{ marginBottom: 4 }}>
                  {new Date(item.date).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                  })}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-display)",
                    fontWeight: 700,
                    fontSize: "var(--text-base)",
                    color: "var(--rpc-text-primary)",
                    letterSpacing: "0.02em",
                    marginBottom: 4,
                    lineHeight: 1.3,
                  }}
                >
                  {item.title}
                </div>
                <div
                  className="rpc-mono"
                  style={{ color: "var(--rpc-text-muted)", lineHeight: 1.6 }}
                >
                  {item.summary}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── RPC Intelligence Tools ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: ACCENT }} />
          <span className="rpc-label">RPC Intelligence</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          {[
            {
              label: "Sniper",
              desc: "Live OpenSea floor deals & listings",
              icon: "⚡",
              status: "LIVE",
              statusColor: "var(--rpc-success)",
              href: "/panini-blockchain/sniper",
              isLink: true,
            },
            {
              label: "Wallet Analyzer",
              desc: "Portfolio tracking for bridged cards",
              icon: "◈",
              status: "COMING SOON",
              statusColor: "var(--rpc-text-ghost)",
              href: "",
              isLink: false,
            },
            {
              label: "Pack EV",
              desc: "Expected value vs pack price",
              icon: "◧",
              status: "COMING SOON",
              statusColor: "var(--rpc-text-ghost)",
              href: "",
              isLink: false,
            },
          ].map((tool) => {
            const inner = (
              <div
                className="rpc-card"
                style={{
                  padding: "16px 18px",
                  cursor: tool.isLink ? "pointer" : "default",
                  position: "relative",
                  overflow: "hidden",
                  opacity: tool.isLink ? 1 : 0.6,
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: 2,
                    background: ACCENT,
                    opacity: 0.5,
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 18, color: ACCENT }}>{tool.icon}</span>
                  <span
                    className="rpc-mono"
                    style={{
                      marginLeft: "auto",
                      fontSize: 9,
                      letterSpacing: "0.12em",
                      color: tool.statusColor,
                      fontWeight: 700,
                    }}
                  >
                    {tool.status}
                  </span>
                </div>
                <div className="rpc-heading" style={{ fontSize: "var(--text-base)", marginBottom: 3 }}>
                  {tool.label}
                </div>
                <div
                  className="rpc-mono"
                  style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}
                >
                  {tool.desc}
                </div>
              </div>
            )
            return tool.isLink ? (
              <Link key={tool.label} href={tool.href} style={{ textDecoration: "none" }}>
                {inner}
              </Link>
            ) : (
              <div key={tool.label}>{inner}</div>
            )
          })}
        </div>
      </section>

      {/* ── About Panini Blockchain ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-text-muted)" }} />
          <span className="rpc-label">About Panini Blockchain</span>
        </div>
        <p
          className="rpc-mono"
          style={{
            color: "var(--rpc-text-muted)",
            lineHeight: 1.7,
            marginBottom: 16,
            maxWidth: 800,
          }}
        >
          Panini Blockchain is Panini America&apos;s digital trading card platform featuring officially
          licensed NBA, NFL, soccer, WNBA, and racing cards. With the Ethereum bridge launched in
          March 2026, collectors can now trade their cards as ERC-721 tokens on OpenSea and other
          Ethereum marketplaces while retaining the ability to bridge back to the Panini ecosystem at
          any time.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {EXTERNAL_LINKS.map((link) => (
            <a
              key={link.label}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="rpc-mono"
              style={{
                fontSize: "var(--text-xs)",
                color: ACCENT,
                textDecoration: "none",
                padding: "4px 12px",
                border: `1px solid ${ACCENT}44`,
                borderRadius: 4,
              }}
            >
              {link.label} →
            </a>
          ))}
        </div>
      </section>
    </div>
  )
}
