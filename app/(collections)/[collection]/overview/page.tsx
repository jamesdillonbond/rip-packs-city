"use client"

import { useEffect, useState, useCallback } from "react"
import { useParams, useRouter } from "next/navigation"
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

interface OverviewStats {
  totalEditions: number
  highConfCount: number
  volume24h: number
  movers: Array<{
    player_name?: string
    set_name?: string
    tier?: string
    old_fmv?: number
    new_fmv?: number
    pct_change?: number
  }>
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
  uncommon:  "var(--tier-uncommon)",
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
  const router = useRouter()
  const collection = (params?.collection as string) ?? "nba-top-shot"

  const [walletInput, setWalletInput] = useState("")
  const [hasWallet, setHasWallet] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem("rpc_last_wallet")) setHasWallet(true)
    } catch {}
  }, [])

  const [pulseData, setPulseData] = useState<MarketPulseData | null>(null)
  const [topSales, setTopSales] = useState<TopSale[]>([])
  const [sniperDeals, setSniperDeals] = useState<SniperDealPreview[]>([])
  const [health, setHealth] = useState<HealthData | null>(null)
  const [overviewStats, setOverviewStats] = useState<OverviewStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [pulseLoading, setPulseLoading] = useState(true)
  const [salesLoading, setSalesLoading] = useState(true)
  const [sniperLoading, setSniperLoading] = useState(true)

  // Fetch overview stats (FMV coverage, volume, movers)
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/overview-stats?collection=" + encodeURIComponent(collection))
      if (!res.ok) return
      setOverviewStats(await res.json())
    } catch { /* swallow */ } finally {
      setStatsLoading(false)
    }
  }, [collection])

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
      const res = await fetch("/api/edition-sales?limit=5&collection=" + encodeURIComponent(collection))
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.sales)) setTopSales(data.sales)
      else if (Array.isArray(data)) setTopSales(data.slice(0, 5))
    } catch { /* swallow */ } finally {
      setSalesLoading(false)
    }
  }, [collection])

  // Fetch top 5 sniper deals with minDiscount=15
  const fetchSniper = useCallback(async () => {
    try {
      const res = await fetch("/api/sniper-feed?limit=5&minDiscount=15&collection=" + encodeURIComponent(collection), { cache: "no-store" })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data.deals)) setSniperDeals(data.deals.slice(0, 5))
    } catch { /* swallow */ } finally {
      setSniperLoading(false)
    }
  }, [collection])

  // Fetch pipeline health for freshness indicator
  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" })
      if (!res.ok) return
      setHealth(await res.json())
    } catch { /* swallow */ }
  }, [])

  useEffect(() => {
    fetchStats()
    fetchPulse()
    fetchSales()
    fetchSniper()
    fetchHealth()
  }, [fetchStats, fetchPulse, fetchSales, fetchSniper, fetchHealth])

  // Derive pipeline freshness
  const fmvMinutes = health?.fmv_pipeline?.minutes_since_last_fmv ?? null
  const freshness = freshnessIndicator(fmvMinutes)
  const basePath = "/" + collection

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Wallet-Connect Hero CTA ── */}
      {!hasWallet && !submitted && (
        <section className="rpc-card" style={{ padding: "32px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 32, color: "var(--rpc-success)", marginBottom: 12 }}>⚡</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-xl)", color: "var(--rpc-text-primary)", letterSpacing: "0.04em", marginBottom: 8 }}>
            SEE YOUR COLLECTION VALUE INSTANTLY
          </div>
          <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", marginBottom: 16 }}>
            Enter your Top Shot username or wallet address
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (!walletInput.trim()) return
              try {
                localStorage.setItem("rpc_last_wallet", walletInput.trim())
                localStorage.setItem("rpc_collection_last_wallet", walletInput.trim())
              } catch {}
              setSubmitted(true)
              router.push("/" + collection + "/collection?address=" + encodeURIComponent(walletInput.trim()))
            }}
            style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}
          >
            <input
              type="text"
              value={walletInput}
              onChange={(e) => setWalletInput(e.target.value)}
              placeholder="Username or 0x address…"
              style={{
                width: 300,
                padding: "10px 14px",
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: "var(--radius-sm)",
                color: "var(--rpc-text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--text-sm)",
                outline: "none",
              }}
            />
            <button
              type="submit"
              style={{
                padding: "10px 20px",
                background: "#E03A2F",
                border: "none",
                borderRadius: "var(--radius-sm)",
                color: "#fff",
                fontFamily: "var(--font-display)",
                fontWeight: 700,
                fontSize: "var(--text-sm)",
                cursor: "pointer",
                letterSpacing: "0.04em",
              }}
            >
              ANALYZE →
            </button>
          </form>
        </section>
      )}

      {/* ── Live Stats ── */}
      {collection === "nba-top-shot" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
          <section className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--rpc-red)", opacity: 0.7 }} />
            <div className="rpc-label" style={{ marginBottom: 4 }}>Total Moments Tracked</div>
            {statsLoading ? (
              <div className="rpc-skeleton" style={{ width: "50%", height: 20 }} />
            ) : (
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: "var(--rpc-text-primary)" }}>
                {(overviewStats?.totalEditions ?? 0).toLocaleString()}
              </div>
            )}
          </section>
          <section className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--rpc-success)", opacity: 0.7 }} />
            <div className="rpc-label" style={{ marginBottom: 4 }}>Verified FMV Coverage</div>
            {statsLoading ? (
              <div className="rpc-skeleton" style={{ width: "50%", height: 20 }} />
            ) : (
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: "var(--rpc-success)" }}>
                {(overviewStats?.highConfCount ?? 0).toLocaleString()}
              </div>
            )}
          </section>
          <section className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--tier-legendary)", opacity: 0.7 }} />
            <div className="rpc-label" style={{ marginBottom: 4 }}>24h Sales Volume</div>
            {statsLoading ? (
              <div className="rpc-skeleton" style={{ width: "50%", height: 20 }} />
            ) : (
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: "var(--tier-legendary)" }}>
                {fmtDollars(overviewStats?.volume24h ?? 0)}
              </div>
            )}
          </section>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
          {["Total Moments Tracked", "FMV Coverage", "24h Sales Volume"].map((label) => (
            <section key={label} className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: "var(--rpc-text-ghost)", opacity: 0.4 }} />
              <div className="rpc-label" style={{ marginBottom: 4 }}>{label}</div>
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: "var(--rpc-text-ghost)" }}>Coming soon</div>
            </section>
          ))}
        </div>
      )}

      {/* ── Golazos Section ── */}
      {collection === "laliga-golazos" && (
        <>
          <section className="rpc-card" style={{ padding: "20px 24px" }}>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "baseline" }}>
              <div className="rpc-heading" style={{ fontSize: "var(--text-lg)", color: "#22C55E" }}>
                575 Editions
              </div>
              <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
              <div className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>23 Sets</div>
              <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
              <div className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>4 Tiers</div>
              <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
              <div className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>Series 1</div>
            </div>
          </section>

          <section className="rpc-card" style={{ padding: "16px 20px" }}>
            <div className="rpc-label" style={{ marginBottom: 12, color: "#22C55E" }}>Featured Sets</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
              {[
                { name: "ElCl\u00E1sico", blurb: "Bar\u00E7a vs Real Madrid. The biggest rivalry in football.", meta: "23 editions · Legendary available" },
                { name: "\u00CDdolos", blurb: "The legends. Reserved for the cream of the crop.", meta: "17 Legendary · floor ~$224" },
                { name: "Estrellas", blurb: "The stars lighting up LaLiga stadiums.", meta: "126 Rare editions" },
                { name: "Lewandowski's Strikers", blurb: "The greatest goal scorers in LaLiga history.", meta: "24 editions · all 4 tiers" },
              ].map((s) => (
                <div key={s.name} style={{ padding: 12, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)" }}>
                  <div className="rpc-heading" style={{ fontSize: "var(--text-sm)", color: "#22C55E", marginBottom: 4 }}>{s.name}</div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-primary)", marginBottom: 6 }}>{s.blurb}</div>
                  <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>{s.meta}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rpc-card" style={{ padding: "16px 20px" }}>
            <div className="rpc-label" style={{ marginBottom: 10, color: "#22C55E" }}>Notable Players</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {["Lionel Messi", "Cristiano Ronaldo", "Neymar", "Robert Lewandowski", "Luka Modri\u0107", "Pedri", "Vin\u00EDcius J\u00FAnior", "Antoine Griezmann", "Andr\u00E9s Iniesta", "Xavi"].map((p) => (
                <span key={p} style={{ padding: "4px 10px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: 999, fontSize: "var(--text-xs)" }}>{p}</span>
              ))}
            </div>
          </section>

          <section className="rpc-card" style={{ padding: "16px 20px" }}>
            <div className="rpc-label" style={{ marginBottom: 8, color: "#22C55E" }}>News</div>
            <div className="rpc-heading" style={{ fontSize: "var(--text-sm)", marginBottom: 4 }}>LaLiga Golazos — Now Live on Rip Packs City</div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-primary)", marginBottom: 4 }}>
              Wallet analysis, FMV pricing, and marketplace intelligence for 575 editions across 23 sets.
            </div>
            <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>2026-04-14</div>
          </section>
        </>
      )}

      {/* ── FMV Movers (24h) ── */}
      {!statsLoading && overviewStats?.movers && overviewStats.movers.length > 0 && (
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-success)" }} />
            <span className="rpc-label">FMV Movers (24h)</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {/* Risers */}
            <div>
              <div className="rpc-label" style={{ marginBottom: 8, color: "var(--rpc-success)" }}>Rising</div>
              {overviewStats.movers
                .filter((m) => (m.pct_change ?? 0) > 0)
                .slice(0, 5)
                .map((m, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", marginBottom: 4 }}>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-sm)", color: "var(--rpc-text-primary)" }}>{m.player_name}</span>
                    <span className="rpc-mono" style={{ color: "var(--rpc-success)", fontWeight: 700, fontSize: "var(--text-sm)" }}>+{(m.pct_change ?? 0).toFixed(1)}%</span>
                  </div>
                ))}
            </div>
            {/* Fallers */}
            <div>
              <div className="rpc-label" style={{ marginBottom: 8, color: "var(--rpc-danger)" }}>Falling</div>
              {overviewStats.movers
                .filter((m) => (m.pct_change ?? 0) < 0)
                .slice(0, 5)
                .map((m, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 10px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", marginBottom: 4 }}>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-sm)", color: "var(--rpc-text-primary)" }}>{m.player_name}</span>
                    <span className="rpc-mono" style={{ color: "var(--rpc-danger)", fontWeight: 700, fontSize: "var(--text-sm)" }}>{(m.pct_change ?? 0).toFixed(1)}%</span>
                  </div>
                ))}
            </div>
          </div>
        </section>
      )}

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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {[
            { label: "Collection",   desc: "FMV \u00b7 Flowty asks \u00b7 badge intel", icon: "\u25C8", color: "var(--rpc-red)", page: "collection" },
            { label: "Pack EV",      desc: "Expected value vs price",                    icon: "\u25A3", color: "var(--tier-legendary)", page: "packs" },
            { label: "Sniper",       desc: "Real-time deals below FMV",                  icon: "\u26A1", color: "var(--rpc-success)", page: "sniper" },
            { label: "Badges",       desc: "Debut \u00b7 Fresh \u00b7 Rookie Year",      icon: "\u2B50", color: "var(--tier-rare)", page: "badges" },
            { label: "Sets",         desc: "Completion + bottleneck finder",              icon: "\u25C9", color: "#F472B6", page: "sets" },
            { label: "Analytics",    desc: "Portfolio breakdown + clarity",               icon: "\u25CE", color: "#A78BFA", page: "analytics" },
            { label: "Market",       desc: "Edition lookup + leaderboards",               icon: "\u25C8", color: "var(--tier-rare)", page: "market" },
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
