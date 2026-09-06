"use client"

import React, { useEffect, useState } from "react"
import Link from "next/link"
import { getCollection } from "@/lib/collections"
import { nameOrDash, fmtPrice, fmtAge, minutesSince, freshnessFromAge, EM_DASH, type Freshness } from "@/lib/collection-overview-format"
import InsiderSignalsPanel from "@/components/InsiderSignalsPanel"
import { MarketplaceStatusBanner } from "@/components/marketplace-status"

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
  // % of editions whose latest FMV snapshot is HIGH or MEDIUM confidence.
  // Reframes the older fmv_pct, which counted any snapshot — including NO_DATA.
  fmv_high_medium_count?: number | null
  fmv_high_medium_pct?: number | null
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
      title: "Collector-grade intelligence",
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
      body: "FMV on All Day reflects real sales data — never ask prices. The sniper works across both the pack-era primary market and secondary marketplaces, so you catch mispriced moments the moment they list.",
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
  "candy-mlb": [
    {
      title: "Built for Baseball Collectors",
      body: "Candy MLB brings officially licensed MLB moments on-chain — Solana, under Candy Digital. RPC tracks every edition, prices it from real secondary sales, and shows collectors what the market is actually paying rather than what sellers are asking.",
    },
    {
      title: "The Candy Ecosystem",
      body: "Candy runs a compact catalogue — base and ICON series across Common and Legendary tiers — with secondary trading on Magic Eden and OpenSea. Because the set is small and trades daily, RPC prices every edition, and the share of prices backed by recent sales is the highest on the platform.",
    },
    {
      title: "What Is Live Here",
      body: "This overview carries the market pulse; the full Candy MLB board (floors, asks, 24h sales, per-edition history) is one tap away below. Wallet analytics and pack tools for Solana wallets are next — they appear here when they are real, not before.",
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
    "\u26A1 BADGE FILTERS \u2014 filter any view by Top Shot Debut \u00B7 Fresh \u00B7 Rookie Year",
    "\u26A1 SET TRACKER \u2014 completion + bottleneck finder",
  ],
  "nfl-all-day": [
    "\u26A1 COLLECTION ANALYZER \u2014 FMV + marketplace asks + badge intel",
    "\u26A1 PACK EV CALCULATOR \u2014 expected value vs drop price",
    "\u26A1 SNIPER \u2014 live deals below FMV",
    "\u26A1 BADGE FILTERS \u2014 Debut \u00B7 Fresh \u00B7 Rookie Year, on any view",
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

// nameOrDash / fmtPrice / fmtAge / minutesSince / freshnessFromAge (+ Freshness)
// extracted to @/lib/collection-overview-format (unit-tested there).

// ── Component ─────────────────────────────────────────────────────────────────

export default function CollectionOverviewClient({ collection }: { collection: string }) {
  const collectionObj = getCollection(collection)
  const accent = collectionObj?.accent ?? "var(--rpc-red)"
  const enabledPages = new Set(collectionObj?.pages ?? [])
  const basePath = "/" + collection

  const [stats, setStats] = useState<CollectionStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setTimedOut(false)
    const timeoutId = setTimeout(() => {
      if (!cancelled) setTimedOut(true)
    }, 5000)
    ;(async () => {
      try {
        const res = await fetch("/api/collection-stats?collection=" + encodeURIComponent(collection))
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: CollectionStats = await res.json()
        if (cancelled) return
        // A body carrying `error` is a FAILURE, not a collection with no data.
        // Storing it would make `stats` truthy, and every KPI below reads
        // `stats ? (stats.x ?? 0) : null` — so a failed read would render as
        // "0 editions / 0% priced / $0" instead of the em-dash the null path
        // already produces correctly (deep-audit D11). The route now returns
        // 503 for this, caught by the !res.ok guard above; this second check
        // stays so no future 200-with-error-body can resurrect the bug.
        if (data && data.error) throw new Error(data.error)
        setStats(data)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [collection])

  const about = COLLECTION_ABOUT[collection] ?? COLLECTION_ABOUT["nba-top-shot"]

  const fmvAge = stats?.fmv_age_minutes ?? null
  // Show loading state until either: data arrives, OR fetch settled with no
  // age and 5s have elapsed (real outage). This prevents the "UNKNOWN" flash
  // first-time visitors used to see during normal pipeline-health resolution.
  const showLoading = loading || (fmvAge == null && !timedOut)
  // UFC Strike's Flow market is frozen by design (Aptos migration) — its FMV is
  // legitimately stale, so don't flash a red OUTDATED pipeline-broken pill.
  const frozenMarket = collection === "ufc"
  const freshness = freshnessFromAge(fmvAge, showLoading, frozenMarket)

  // ── Failed read vs empty result (deep-audit R1) ──────────────────────────
  // The KPI band above already distinguishes these correctly (D11), but the
  // two list panels below did not: they applied `?? 0` to the SAME null
  // `stats` and rendered "No deals ≥15% off right now" / "No sales in the
  // last 24h" — a claim about the MARKET manufactured from an outage of OURS.
  // Measured 2026-08-15 while `/api/collection-stats` was honestly 503ing:
  // Top Shot had done 8,332 sales and All Day 240 in the window both pages
  // called empty, and this page contradicted itself on screen (its own
  // Insider Signals panel listed 269- and 171-moment sweeps from 1–2h prior).
  // `statsUnavailable` is the answer to "did the READ succeed", never "were
  // there rows" — the two are different claims and must not share a branch.
  const statsUnavailable = !loading && (error != null || stats == null)

  // Top sales are name-filtered before render, so the empty-state guard MUST
  // run on the POST-filter array. It used to test the raw array: when every
  // row resolved to a dash the guard saw length 5, skipped the empty state,
  // and the filter then stripped all 5 — a blank panel with no copy at all.
  //
  // ⚠ THAT FIX WAS NECESSARY AND NOT SUFFICIENT, and the residue is a THIRD
  // claim this panel can make (deep-audit R4, finished 2026-08-15). The filter
  // drops rows the read SUCCEEDED on — we have the sale, we cannot name it —
  // so routing them into the existing empty state publishes "No sales in the
  // last 24h", a claim about the MARKET manufactured from a gap in OUR
  // catalog. Measured live the same day: Disney Pinnacle did 960 sales in 24h
  // with 60% carrying a NULL edition_id, and 2 of the top 5 by price were
  // unnameable — so the panel was silently serving a 3-row "Top 5" and was one
  // unlucky draw away from asserting a busy market had gone silent.
  //
  // ⚠ The earlier note calling this "a Pinnacle ingest regression" was wrong
  // and is corrected here: nothing regressed. It is a catalog-coverage gap
  // (`pinnacle_nft_map` does not cover every traded NFT) that a 4.5× volume
  // jump on 08-14 made visible. The distinction matters because a coverage gap
  // is PERMANENT-ish and will keep producing unnameable rows, so the copy has
  // to survive it rather than wait for a fix.
  //
  // Three distinct states, three distinct sentences — never share a branch:
  //   read failed        → statsUnavailable  ("couldn't load")
  //   read ok, 0 rows    → rawTopSales empty ("no sales") — an honest market claim
  //   read ok, 0 nameable→ every row dropped ("N not matched yet") — about US
  const sniperDeals = stats?.sniper_deals ?? []
  const rawTopSales = stats?.top_sales ?? []
  const topSales = rawTopSales.filter(
    (s) => nameOrDash(s.edition_name, s.player_name, s.character_name) !== EM_DASH,
  )
  // Successfully-read sales we could not put a name to. Disclosed rather than
  // dropped: a "Top 5" quietly rendering 3 rows is a truncated ranking served
  // as the complete one.
  const unnamedTopSales = rawTopSales.length - topSales.length

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

      {/* ── Marketplace Status Banner — shown only when not healthy ── */}
      <MarketplaceStatusBanner collectionSlug={collection} />

      {/* ── Wallet-search entry point: MOVED TO THE LAYOUT (2026-07-25) ──────
          This page used to own a private FORK of the homepage wallet input. It
          emitted no wallet_paste at all, and it pushed anon visitors at the
          AUTH-GATED /dashboard — the #1 CTA on a public landing bounced to
          /login. Both bugs are fixed by DELETING it rather than patching it:
          components/WalletSearchBand now renders once from
          app/(collections)/[collection]/layout.tsx, so every tab in the subtree
          gets the wedge (/overview was only 8.8% of collection_view over 30d)
          with surface="collection_layout" and a public /share/<wallet> landing.
          Nothing replaces this block here — a second box would be a duplicate.
          The KPI row below is now the first content on the page. */}

      {/* ── KPI Cards ── */}
      <div className="rpc-ov-kpi3">
        <KpiCard
          label="Total Editions"
          accent={accent}
          loading={loading}
          valueColor="var(--rpc-text-primary)"
          value={stats ? (stats.edition_count ?? 0).toLocaleString() : null}
        />
        {/* Relabelled 2026-08-01 (was "FMV Confidence" / "62% HIGH/MED"). The tile
            printed the internal confidence enum on a public, unauthenticated page —
            the standing no-confidence-UI policy — and "HIGH/MED" is uncalibratable
            for a visitor who has never seen the scale. The underlying number is
            unchanged: the share of this collection's editions whose FMV rests on
            corroborated recent sales rather than an ask or nothing. Relabelled
            rather than deleted, so the KPI row keeps its three cells. */}
        <KpiCard
          label="Priced from Sales"
          accent={accent}
          loading={loading}
          valueColor={accent}
          /* ⚠ NO FALLBACK TO `fmv_pct`, AND THE OLD ONE WAS A FALSE CLAIM.
             This cell used to render `fmv_pct` when `fmv_high_medium_pct` was
             null. Those are DIFFERENT METRICS: `fmv_pct` is the share of
             editions carrying any non-NO_DATA snapshot, which is far larger.
             Measured 2026-09-02 — LaLiga Golazos 87.3% vs a true 0.3%, UFC
             Strike 73.6% vs a true 0.0%. A failed read of the HIGH/MEDIUM share
             would have published a 291× overstatement under the label
             "Priced from Sales". Null renders the skeleton, which says nothing
             rather than something false. Zero is a real value here and still
             renders as "0%". */
          value={
            stats && stats.fmv_high_medium_pct != null
              ? `${Math.round(stats.fmv_high_medium_pct)}%`
              : null
          }
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
      <div className="rpc-ov-2col">

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
          ) : statsUnavailable ? (
            <PanelUnavailable />
          ) : sniperDeals.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>
              {collection === "disney-pinnacle"
                ? "No active listings right now"
                : <>No deals {"\u2265"}15% off right now</>}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {sniperDeals.slice(0, 5).map((deal, i) => {
                const name = nameOrDash(deal.player_name, deal.character_name)
                // Sub-$1 commons render as "$0" via fmtPrice (Math.round) and pair with an
                // FMV-inflated discount %, which reads as a broken deal. Relabel the ask as
                // "<$1" and suppress the discount badge for those rows.
                const askIsSubDollar = deal.ask_price > 0 && deal.ask_price < 1
                const hasDiscount = typeof deal.discount === "number" && deal.discount > 0 && !askIsSubDollar
                const gridCols = hasDiscount ? "minmax(0,1fr) auto auto" : "minmax(0,1fr) auto"
                const content = (
                  <>
                    <div>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)" }}>{name}</div>
                      <div className="rpc-mono" style={{ color: tierColor(deal.tier, collection), fontSize: "var(--text-xs)" }}>
                        {deal.tier ?? ""}
                        {deal.set_name ? <> &middot; <span style={{ color: "var(--rpc-text-muted)" }}>{deal.set_name}</span></> : null}
                      </div>
                    </div>
                    <div className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>{askIsSubDollar ? "<$1" : fmtPrice(deal.ask_price)}</div>
                    {hasDiscount && (
                      <div className="rpc-mono" style={{ color: "var(--rpc-red)", fontWeight: 700 }}>-{Math.round(deal.discount as number)}%</div>
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
            {freshness.loading ? (
              <div
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  border: "1.5px solid var(--rpc-border)",
                  borderTopColor: "var(--rpc-text-muted)",
                  animation: "rpc-spin 0.9s linear infinite",
                }}
              />
            ) : (
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: freshness.color, animation: "pulse 2s infinite", border: "1px solid " + freshness.color }} />
            )}
            <span className="rpc-label">Pipeline Status</span>
            <span className="rpc-mono" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: freshness.color, fontWeight: 700, letterSpacing: "0.1em" }}>
              {freshness.label}
            </span>
          </div>

          <div className="rpc-card" style={{ padding: "12px 14px", position: "relative", overflow: "hidden" }}>
            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: freshness.color, opacity: 0.7 }} />
            <div className="rpc-label" style={{ marginBottom: 4 }}>FMV Data Age</div>
            {showLoading ? (
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
              { color: "var(--rpc-red)", label: "> 60 min" },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: item.color }} />
                <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Insider Signals (anomaly detection across sales activity) ── */}
      <InsiderSignalsPanel collection={collection} basePath={basePath} />

      {/* ── Recent Top Sales + About the Community ── */}
      <div className="rpc-ov-2col">

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
          ) : statsUnavailable ? (
            <PanelUnavailable />
          ) : rawTopSales.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>
              No sales in the last 24h
            </div>
          ) : topSales.length === 0 ? (
            // Read succeeded and the market traded — we just can't name any of
            // it. Saying "no sales" here would be a false claim about the
            // market; this says the true thing, which is about our catalog.
            <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>
              {rawTopSales.length} recent {rawTopSales.length === 1 ? "sale" : "sales"} not yet matched to a moment
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topSales
                .slice(0, 5)
                .map((sale, i) => {
                const name = nameOrDash(sale.edition_name, sale.player_name, sale.character_name)
                const ageMin = minutesSince(sale.sold_at)
                const serialDisplay = sale.serial_number != null && sale.serial_number > 0
                  ? (sale.circulation_count != null ? `#${sale.serial_number}/${sale.circulation_count}` : `#${sale.serial_number}`)
                  : null
                return (
                  <div key={i} style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center" }}>
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
              {unnamedTopSales > 0 && (
                <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", paddingTop: 2 }}>
                  {unnamedTopSales} more {unnamedTopSales === 1 ? "sale" : "sales"} in this window not yet matched to a moment
                </div>
              )}
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

      {/* ── Per-collection News (from lib/collections.ts news[]) ── */}
      {collectionObj?.news && collectionObj.news.length > 0 && (
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">News &amp; Updates</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {collectionObj.news.map((n, i) => (
              <a
                key={i}
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: "block", padding: "12px 14px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", textDecoration: "none" }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4, flexWrap: "wrap" }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-base)", color: "var(--rpc-text-primary)" }}>
                    {n.title}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginLeft: "auto" }}>
                    {n.date}
                  </div>
                </div>
                <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
                  {n.summary}
                </div>
              </a>
            ))}
          </div>
        </section>
      )}

      {/* ── Fast Break cross-link (Top Shot only) ── */}
      {process.env.NEXT_PUBLIC_SHOW_FAST_BREAK === "1" && collection === "nba-top-shot" && (
        <section
          className="rpc-card"
          style={{ padding: "16px 20px" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--rpc-red)" }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 240 }}>
              <span className="rpc-label" style={{ fontFamily: "var(--font-display)" }}>
                Fast Break Optimizer
              </span>
              <span
                className="rpc-mono"
                style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}
              >
                Daily optimal Top Shot Fast Break lineup · public, no signup · updated every 15 min
              </span>
            </div>
            <Link
              href="/nba/fast-break"
              className="rpc-mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--rpc-red)",
                textDecoration: "none",
                padding: "8px 14px",
                border: "1px solid var(--rpc-red-border)",
                background: "var(--rpc-red-bg)",
                borderRadius: "var(--radius-sm)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Open Optimizer →
            </Link>
          </div>
        </section>
      )}

      {/* ── The live board (thin-tab collections: everything past the overview lives on the insights board) ── */}
      {collection === "candy-mlb" && (
        <section className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.7 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">Candy MLB board</span>
          </div>
          <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
            Every edition with its floor, best ask, FMV and 24h sales — the full Candy MLB intelligence board, updated continuously.
          </div>
          <Link href="/insights/candy-mlb" className="rpc-heading" style={{ display: "inline-block", padding: "10px 18px", background: accent, color: "#0B0B0D", borderRadius: 6, fontSize: "var(--text-sm)", letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
            Open the Candy MLB board →
          </Link>
        </section>
      )}

      {/* ── Tools ── */}
      {enabledPages.size > 1 && (
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
      )}

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

// Rendered when the collection-stats READ failed, in place of an empty state.
// "We couldn't load this" is a claim about US; "there are none" is a claim
// about the MARKET. Collapsing them is the failure-renders-as-data class the
// honesty table in CLAUDE.md exists to prevent — and the wording here must not
// imply the market is quiet. The page-level amber banner carries the retry
// guidance, so this stays a short, non-duplicating line.
function PanelUnavailable() {
  return (
    <div className="rpc-mono" style={{ color: "var(--rpc-text-ghost)", padding: "16px 0", textAlign: "center" }}>
      {"Couldn’t load this right now"}
    </div>
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
