"use client"

import { useEffect, useState } from "react"
import { useParams, useRouter } from "next/navigation"
import Link from "next/link"
import { getCollection } from "@/lib/collections"

// ── Types ─────────────────────────────────────────────────────────────────────

interface TopSale {
  edition_name?: string | null
  player_name?: string | null
  character_name?: string | null
  set_name?: string | null
  tier?: string | null
  price: number
  serial_number?: number | null
  circulation_count?: number | null
  sold_at?: string | null
}

interface SniperDeal {
  player_name?: string | null
  character_name?: string | null
  set_name?: string | null
  tier?: string | null
  ask_price: number
  fmv?: number | null
  discount?: number | null
  buy_url?: string | null
  thumbnail_url?: string | null
  badge_slugs?: string[] | null
  serial_number?: number | null
}

interface CollectionStats {
  edition_count: number
  fmv_covered?: number
  fmv_pct: number
  fmv_age_minutes: number | null
  volume_24h: number
  sales_24h?: number
  listing_count?: number
  top_sales: TopSale[]
  sniper_deals: SniperDeal[]
  error?: string
}

// ── Copy ──────────────────────────────────────────────────────────────────────

type AboutBlock = { title: string; body: string }

const COLLECTION_ABOUT: Record<string, AboutBlock[]> = {
  "nba-top-shot": [
    {
      title: "Built for Collectors, By Collectors",
      body: "Rip Packs City started as a tool for the Portland Trail Blazers community on NBA Top Shot — collectors who care about getting real value from their moments, not just chasing hype. That same obsession with data and fairness drives everything here.",
    },
    {
      title: "The Top Shot Ecosystem",
      body: "NBA Top Shot has traded over $1 billion in moments since 2020. Behind those numbers is a global community of collectors who track serial numbers, chase badge premiums, complete sets, and hunt deals across multiple marketplaces. RPC gives that community the intelligence layer it deserves — FMV that reflects real sales, not ask prices.",
    },
    {
      title: "Data-First Philosophy",
      body: "Every tool here is built on the same principle: show collectors what the market is actually paying, not what sellers are asking. Fair market value, scarcity analysis, badge premiums, set completion — transparent data, not guesswork.",
    },
  ],
  "nfl-all-day": [
    {
      title: "Built for Football Collectors",
      body: "NFL All Day brings gridiron moments on-chain for serious football collectors. RPC tracks every serial, surfaces badge premiums for Debut, Fresh, and Rookie Year moments, and helps you evaluate scarcity at a glance across the entire All Day catalogue.",
    },
    {
      title: "The All Day Ecosystem",
      body: "All Day has minted hundreds of thousands of moments since launch, with packs dropping alongside the NFL season. Pack EV is a core tool here — we break down expected value against drop price so you can decide when to rip and when to pass. Set completion matters, and RPC tracks your progress across every tier.",
    },
    {
      title: "Intelligence for Every Drop",
      body: "FMV on All Day reflects real sales data — never ask prices. The sniper works across both the pack-era primary market and secondary marketplaces, so you catch mispriced moments the moment they list. Built for collectors who treat the game like collectors treat the hobby.",
    },
  ],
  "disney-pinnacle": [
    {
      title: "Built for Pin Collectors",
      body: "Disney Pinnacle brings Disney, Pixar, and Marvel digital collectibles on-chain. Character-driven scarcity drives value here — a Mickey pin carries different weight than a lesser-known supporting character, and RPC surfaces those premiums through real market data.",
    },
    {
      title: "The Pinnacle Ecosystem",
      body: "Dapper's entertainment collectibles platform spans pin variants and edition types — Standard, Silver Sparkle, Golden, and limited runs — each with its own scarcity curve. RPC tracks every edition, every variant, and the relative value between them so collectors can navigate the catalogue with real intelligence.",
    },
    {
      title: "FMV for Entertainment Collectibles",
      body: "Pinnacle FMV is driven by ask-price intelligence, with deal-finding that spans character lines, franchise affiliations, and variant rarity. The sniper flags pins priced below what comparable pins are asking elsewhere — spot deals across Mickey, Marvel heroes, or Pixar favourites in one view.",
    },
  ],
  "laliga-golazos": [
    {
      title: "Built for Football Intelligence",
      body: "LaLiga Golazos captures the best goals and skills from Spanish football on Flow — the league of Messi, Ronaldo, Lewandowski, and the next generation. RPC tracks every moment across every tier so collectors can measure scarcity against price in the Spanish football market.",
    },
    {
      title: "The Golazos Ecosystem",
      body: "Golazos runs a clean four-tier structure (Legendary, Rare, Uncommon, Fandom) across 575 editions and 23 sets. Because volume is lighter than Top Shot, floor pricing matters — RPC measures relative value against the floor so you can see which moments are priced correctly and which aren't.",
    },
    {
      title: "Deals Relative to Market",
      body: "The Golazos sniper uses relative deal scoring rather than raw FMV discount — comparing each ask against the edition's current floor and against comparable moments. A 100x-floor outlier filter keeps stray high-asks from distorting the signal, so deals you see are deals you can act on.",
    },
  ],
  "ufc": [
    {
      title: "Built for Fight Collectors",
      body: "UFC Strike brought octagon moments to Flow — round-by-round highlights, finishes, and championship fights from the biggest stage in combat sports. RPC supports the Flow-era collector base with full catalogue intelligence across every fight card.",
    },
    {
      title: "The Strike Ecosystem",
      body: "UFC Strike's edition structure revolves around fighter- and fight-based scarcity, with Challenger and Contender tiers defining the hierarchy. RPC tracks every edition across every fighter so you can measure scarcity and price at the moment level, not just the fighter level.",
    },
    {
      title: "Intelligence for Combat Collectibles",
      body: "UFC FMV is driven by real sales data from the Flow marketplace, with deal-finding tuned for a niche but passionate collector base. The sniper catches fight moments priced below market so you can build your roster without overpaying on the secondary.",
    },
  ],
}

const COLLECTION_TICKER: Record<string, string[]> = {
  "nba-top-shot": [
    "\u26A1 COLLECTION ANALYZER \u2014 FMV + Flowty asks + badge intel",
    "\u26A1 PACK EV CALCULATOR \u2014 expected value vs price",
    "\u26A1 SNIPER \u2014 real-time deals below FMV",
    "\u26A1 BADGE TRACKER \u2014 Top Shot Debut \u00B7 Fresh \u00B7 Rookie Year",
    "\u26A1 SET TRACKER \u2014 completion + bottleneck finder",
  ],
  "nfl-all-day": [
    "\u26A1 COLLECTION ANALYZER \u2014 FMV + marketplace asks + badge intel",
    "\u26A1 PACK EV CALCULATOR \u2014 expected value vs drop price",
    "\u26A1 SNIPER \u2014 live deals below FMV",
    "\u26A1 BADGE TRACKER \u2014 Debut \u00B7 Fresh \u00B7 Rookie Year premiums",
    "\u26A1 SET TRACKER \u2014 completion progress + bottleneck finder",
  ],
  "disney-pinnacle": [
    "\u26A1 COLLECTION ANALYZER \u2014 FMV + active listing prices",
    "\u26A1 SNIPER \u2014 pins priced below market",
    "\u26A1 ANALYTICS \u2014 portfolio value + deal history",
  ],
  "laliga-golazos": [
    "\u26A1 COLLECTION ANALYZER \u2014 relative deal scoring + FMV",
    "\u26A1 SNIPER \u2014 floor deals with outlier filter",
    "\u26A1 FMV COVERAGE \u2014 growing from real sales data",
  ],
  "ufc": [
    "\u26A1 COLLECTION ANALYZER \u2014 FMV + active listing prices",
    "\u26A1 SNIPER \u2014 fight moments below market",
    "\u26A1 ANALYTICS \u2014 portfolio tracking",
  ],
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const TIER_COLORS: Record<string, string> = {
  legendary: "var(--tier-legendary)",
  rare: "var(--tier-rare)",
  uncommon: "var(--tier-uncommon)",
  fandom: "var(--tier-fandom)",
  common: "var(--tier-common)",
  ultimate: "var(--tier-ultimate)",
  champion: "var(--tier-champion)",
  challenger: "var(--tier-challenger)",
  contender: "var(--tier-contender)",
}
function tierColor(tier: string | null | undefined, collection: string) {
  // Pinnacle uses edition_type labels (Open Edition, Limited Edition, …)
  // which don't map to the TopShot/AllDay tier colour enum — render neutral.
  if (collection === "disney-pinnacle") return "var(--rpc-text-muted)"
  return TIER_COLORS[tier?.toLowerCase() ?? ""] ?? "var(--tier-common)"
}

const EM_DASH = "\u2014"
function nameOrDash(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c
  }
  return EM_DASH
}

function fmtPrice(n: number) {
  return "$" + Math.round(n).toLocaleString()
}

function fmtAge(minutes: number | null): string {
  if (minutes == null) return "\u2014"
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${Math.round(minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function minutesSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, (Date.now() - t) / 60000)
}

type Freshness = { color: string; label: string }
function freshnessFromAge(minutes: number | null): Freshness {
  if (minutes == null) return { color: "var(--rpc-text-ghost)", label: "UNKNOWN" }
  if (minutes < 30) return { color: "#34D399", label: "HEALTHY" }
  if (minutes < 60) return { color: "#F59E0B", label: "STALE" }
  return { color: "#E03A2F", label: "CRITICAL" }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function OverviewPage() {
  const params = useParams()
  const router = useRouter()
  const collection = (params?.collection as string) ?? "nba-top-shot"
  const collectionObj = getCollection(collection)
  const accent = collectionObj?.accent ?? "#E03A2F"
  const enabledPages = new Set(collectionObj?.pages ?? [])
  const basePath = "/" + collection

  const [stats, setStats] = useState<CollectionStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [walletInput, setWalletInput] = useState("")
  const [hasWallet, setHasWallet] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    try {
      if (localStorage.getItem("rpc_last_wallet")) setHasWallet(true)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await fetch("/api/collection-stats?collection=" + encodeURIComponent(collection))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: CollectionStats = await res.json()
        if (cancelled) return
        setStats(data)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [collection])

  const ctaSubtitle = collection === "nba-top-shot"
    ? "Enter your Top Shot username or wallet address"
    : "Enter your Flow wallet address to see your holdings"

  const about = COLLECTION_ABOUT[collection] ?? COLLECTION_ABOUT["nba-top-shot"]

  const fmvAge = stats?.fmv_age_minutes ?? null
  const freshness = freshnessFromAge(fmvAge)

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Wallet-Connect Hero CTA ── */}
      {!hasWallet && !submitted && (
        <section className="rpc-card" style={{ padding: "32px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 32, color: accent, marginBottom: 12 }}>{"\u26A1"}</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-xl)", color: "var(--rpc-text-primary)", letterSpacing: "0.04em", marginBottom: 8 }}>
            SEE YOUR COLLECTION VALUE INSTANTLY
          </div>
          <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", marginBottom: 16 }}>
            {ctaSubtitle}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const value = walletInput.trim()
              if (!value) return
              try {
                localStorage.setItem("rpc_last_wallet", value)
                localStorage.setItem("rpc_collection_last_wallet", value)
              } catch { /* ignore */ }
              setSubmitted(true)
              router.push("/profile?wallet=" + encodeURIComponent(value))
            }}
            style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}
          >
            <input
              type="text"
              value={walletInput}
              onChange={(e) => setWalletInput(e.target.value)}
              placeholder={collection === "nba-top-shot" ? "Username or 0x address\u2026" : "0x address\u2026"}
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
                background: accent,
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
              ANALYZE {"\u2192"}
            </button>
          </form>
        </section>
      )}

      {/* ── KPI Cards ── */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
        <KpiCard
          label="Total Editions"
          accent={accent}
          loading={loading}
          valueColor="var(--rpc-text-primary)"
          value={stats ? (stats.edition_count ?? 0).toLocaleString() : null}
        />
        <KpiCard
          label="FMV Coverage"
          accent={accent}
          loading={loading}
          valueColor={accent}
          value={stats ? `${Math.round(stats.fmv_pct ?? 0)}%` : null}
        />
        <KpiCard
          label="24h Sales Volume"
          accent={accent}
          loading={loading}
          valueColor="#34D399"
          value={stats ? `$${Math.round(stats.volume_24h ?? 0).toLocaleString()}` : null}
        />
      </div>

      {error && (
        <section className="rpc-card" style={{ padding: "12px 16px", borderLeft: "3px solid #F59E0B" }}>
          <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
            {"Couldn\u2019t load collection stats right now. Data will refresh on next reload."}
          </div>
        </section>
      )}

      {/* ── Sniper Deals + Pipeline Status ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Top 5 Sniper Deals */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">
              {collection === "disney-pinnacle" ? "Cheapest Available Asks" : "Top 5 Sniper Deals"}
            </span>
            <Link href={basePath + "/sniper"} className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>
              View all {"\u2192"}
            </Link>
          </div>
          {loading ? (
            <SkeletonRows />
          ) : (stats?.sniper_deals?.length ?? 0) === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>
              {collection === "disney-pinnacle"
                ? "No active listings right now"
                : <>No deals {"\u2265"}15% off right now</>}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(stats?.sniper_deals ?? []).slice(0, 5).map((deal, i) => {
                const name = nameOrDash(deal.player_name, deal.character_name)
                const hasDiscount = typeof deal.discount === "number" && deal.discount > 0
                const gridCols = hasDiscount ? "1fr auto auto" : "1fr auto"
                const content = (
                  <>
                    <div>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)" }}>{name}</div>
                      <div className="rpc-mono" style={{ color: tierColor(deal.tier, collection), fontSize: "var(--text-xs)" }}>
                        {deal.tier ?? ""}
                        {deal.set_name ? <> &middot; <span style={{ color: "var(--rpc-text-muted)" }}>{deal.set_name}</span></> : null}
                      </div>
                    </div>
                    <div className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>{fmtPrice(deal.ask_price)}</div>
                    {hasDiscount && (
                      <div className="rpc-mono" style={{ color: "#E03A2F", fontWeight: 700 }}>-{Math.round(deal.discount as number)}%</div>
                    )}
                  </>
                )
                const rowStyle = { display: "grid", gridTemplateColumns: gridCols, gap: 12, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center", textDecoration: "none" } as const
                return deal.buy_url ? (
                  <a key={i} href={deal.buy_url} target="_blank" rel="noopener noreferrer" style={rowStyle}>
                    {content}
                  </a>
                ) : (
                  <Link key={i} href={basePath + "/sniper"} style={rowStyle}>
                    {content}
                  </Link>
                )
              })}
            </div>
          )}
        </section>

        {/* Pipeline Status */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: freshness.color, animation: "pulse 2s infinite", border: "1px solid " + freshness.color }} />
            <span className="rpc-label">Pipeline Status</span>
            <span className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: freshness.color, fontWeight: 700, letterSpacing: "0.1em" }}>
              {freshness.label}
            </span>
          </div>

          <div className="rpc-card" style={{ padding: "12px 14px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: freshness.color, opacity: 0.7 }} />
            <div className="rpc-label" style={{ marginBottom: 4 }}>FMV Data Age</div>
            {loading ? (
              <div className="rpc-skeleton" style={{ width: "40%", height: 20 }} />
            ) : (
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: freshness.color }}>
                {fmtAge(fmvAge)}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14 }}>
            {[
              { color: "#34D399", label: "< 30 min" },
              { color: "#F59E0B", label: "30\u201360 min" },
              { color: "#E03A2F", label: "> 60 min" },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: item.color }} />
                <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Recent Top Sales + About the Community ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* Recent Top Sales */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--tier-legendary)" }} />
            <span className="rpc-label">Recent Top Sales</span>
            <Link href={basePath + "/sniper"} className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>
              View all {"\u2192"}
            </Link>
          </div>
          {loading ? (
            <SkeletonRows />
          ) : (stats?.top_sales?.length ?? 0) === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>
              No sales in the last 24h
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {(stats?.top_sales ?? []).slice(0, 5).map((sale, i) => {
                const name = nameOrDash(sale.edition_name, sale.player_name, sale.character_name)
                const ageMin = minutesSince(sale.sold_at)
                const serialDisplay = sale.serial_number != null
                  ? (sale.circulation_count != null ? `#${sale.serial_number}/${sale.circulation_count}` : `#${sale.serial_number}`)
                  : null
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center" }}>
                    <div>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)" }}>{name}</div>
                      <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginTop: 2 }}>
                        {sale.tier && <span style={{ color: tierColor(sale.tier, collection) }}>{sale.tier}</span>}
                        {sale.set_name && <>{sale.tier ? " \u00B7 " : ""}{sale.set_name}</>}
                        {serialDisplay && <> &middot; {serialDisplay}</>}
                        {ageMin != null && <> &middot; {fmtAge(ageMin)}</>}
                      </div>
                    </div>
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", color: "#34D399", textAlign: "right" }}>
                      {fmtPrice(sale.price)}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* About the Community */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">About the Community</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {about.map((block, i) => (
              <div key={i} style={{ padding: "16px 0", borderTop: i > 0 ? "1px solid var(--rpc-border)" : "none" }}>
                <div style={{ fontSize: "var(--text-base)", fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", letterSpacing: "0.03em", marginBottom: 6 }}>
                  {block.title}
                </div>
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", lineHeight: 1.7, opacity: 0.85 }}>
                  {block.body}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Tools ── */}
      <section className="rpc-card" style={{ padding: "16px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-text-muted)" }} />
          <span className="rpc-label">Tools</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10 }}>
          {[
            {
              label: "Collection",
              desc: collection === "disney-pinnacle"
                ? "FMV \u00b7 listing prices \u00b7 deal finder"
                : "FMV \u00b7 Flowty asks \u00b7 badge intel",
              icon: "\u25C8",
              color: accent,
              page: "collection",
            },
            { label: "Pack EV",   desc: "Expected value vs price",             icon: "\u25A3", color: "var(--tier-legendary)", page: "packs" },
            { label: "Sniper",    desc: "Real-time deals below FMV",           icon: "\u26A1", color: "#34D399",                page: "sniper" },
            { label: "Badges",    desc: "Debut \u00b7 Fresh \u00b7 Rookie Year", icon: "\u2B50", color: "var(--tier-rare)",      page: "badges" },
            { label: "Sets",      desc: "Completion + bottleneck finder",       icon: "\u25C9", color: "#F472B6",                page: "sets" },
            { label: "Analytics", desc: "Portfolio breakdown + clarity",        icon: "\u25CE", color: "#A78BFA",                page: "analytics" },
            { label: "Market",    desc: "Edition lookup + leaderboards",        icon: "\u25C8", color: "var(--tier-rare)",      page: "market" },
          ].filter((t) => enabledPages.has(t.page as never)).map(({ label, desc, icon, color, page }) => (
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

// ── Sub-components ────────────────────────────────────────────────────────────

function KpiCard({
  label,
  accent,
  loading,
  valueColor,
  value,
}: {
  label: string
  accent: string
  loading: boolean
  valueColor: string
  value: string | null
}) {
  return (
    <section className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.7 }} />
      <div className="rpc-label" style={{ marginBottom: 4 }}>{label}</div>
      {loading || value == null ? (
        <div className="rpc-skeleton" style={{ width: "50%", height: 20 }} />
      ) : (
        <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: valueColor }}>
          {value}
        </div>
      )}
    </section>
  )
}

function SkeletonRows() {
  return (
    <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      {[100, 80, 60].map((w, i) => (
        <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, height: 12 }} />
      ))}
    </div>
  )
}
