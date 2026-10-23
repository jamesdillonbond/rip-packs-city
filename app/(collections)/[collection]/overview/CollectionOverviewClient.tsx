"use client"

import React, { useEffect, useRef, useState } from "react"
import Link from "next/link"
import { getCollection } from "@/lib/collections"
import { nameOrDash, fmtPrice, fmtAge, minutesSince, freshnessFromAge, EM_DASH } from "@/lib/collection-overview-format"
import InsiderSignalsPanel from "@/components/InsiderSignalsPanel"
import { MarketplaceStatusBanner } from "@/components/marketplace-status"
import { toolCardDesc } from "@/lib/collection/closed-market-chrome"
import { closedMarket } from "@/lib/market-closed"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"
import { trackOutboundClick } from "@/lib/track-click"
import type { PaniniCoverage } from "@/lib/panini/coverage"
import { accentText } from "@/lib/accent-text"

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
  // get_collection_stats names it flow_id, but it is the EDITION key (editions.external_id;
  // Pinnacle: the render id) — sent as editionKey for click attribution.
  flow_id?: string | null
}

interface CollectionStats {
  edition_count: number
  fmv_covered?: number
  fmv_pct: number
  // % of editions whose latest FMV snapshot is HIGH or MEDIUM confidence.
  // Reframes the older fmv_pct, which counted any snapshot — including NO_DATA.
  fmv_high_medium_count?: number | null
  fmv_high_medium_pct?: number | null
  // #205 (2026-10-21): % of editions with >= 1 market sale in the last 30 days
  // (mv_collection_recent_sale_share, hourly). What the "Priced from Recent
  // Sales" tile shows. null = unread or too old to publish.
  recent_sale_pct?: number | null
  recent_sale_count?: number | null
  recent_sale_editions?: number | null
  recent_sale_failed?: boolean
  fmv_age_minutes: number | null
  // null when the collection's sales are NOT a tracked feed (Panini: the route
  // sets `sales_tracked: false` and nulls these rather than serving the Flow
  // feeds' zeros as a market fact).
  volume_24h: number | null
  sales_24h?: number | null
  listing_count?: number | null
  top_sales: TopSale[] | null
  sniper_deals: SniperDeal[] | null
  sales_tracked?: boolean
  // Panini (2026-10-14): its list panels read Panini's own sources with their
  // own scope — $100+ sales over the last N days — and a failed read nulls the
  // list (a null list is "not measured", never "none").
  top_sales_scope?: { days: number; min_usd: number } | null
  coverage?: PaniniCoverage | null
  coverage_failed?: boolean
  error?: string
}

// ── Copy ──────────────────────────────────────────────────────────────────────

type AboutBlock = { title: string; body: string }

// ⚠ 2026-10-22: these panels said FMV is "never ask prices" (All Day), "not ask prices" (Top Shot),
// "rather than what sellers are asking" (Candy) — while every one of those collections prices an
// edition with no recent sales from its lowest live ask (ASK_ONLY, marked "from asks"; the
// methodology page says so) — and Pinnacle's said "driven by ask-price intelligence" when ~2/3 of
// its priced pins are priced from sales. Pinned by
// __tests__/collection-about-copy-matches-fmv-method.test.ts.
const COLLECTION_ABOUT: Record<string, AboutBlock[]> = {
  "nba-top-shot": [
    {
      title: "Collector-grade intelligence",
      body: "Rip Packs City started as a tool for the Portland Trail Blazers community on NBA Top Shot — collectors who care about getting real value from their moments, not just chasing hype. That same obsession with data and fairness drives everything here.",
    },
    {
      title: "The Top Shot Ecosystem",
      body: "NBA Top Shot has traded over $1 billion in moments since 2020. Behind those numbers is a global community of collectors who track serial numbers, chase badge premiums, complete sets, and hunt deals across multiple marketplaces. RPC gives that community the intelligence layer it deserves — FMV built from what collectors actually paid.",
    },
    {
      title: "Data-First Philosophy",
      body: "Every tool here is built on the same principle: show collectors what the market is actually paying. When an edition has no recent sales, its estimate comes from its lowest live ask and is marked as such. Fair market value, scarcity analysis, badge premiums, set completion — transparent data, not guesswork.",
    },
  ],
  "nfl-all-day": [
    {
      title: "Built for Football Collectors",
      body: "NFL All Day brings gridiron moments on-chain for serious football collectors. RPC tracks every serial, surfaces badge premiums for Debut, Fresh, and Rookie Year moments, and helps you evaluate scarcity at a glance across the entire All Day catalogue.",
    },
    {
      title: "The All Day Ecosystem",
      body: "All Day has minted millions of moments since launch, with packs dropping alongside the NFL season. Pack EV is a core tool here — we break down expected value against drop price so you can decide when to rip and when to pass. Set completion matters, and RPC tracks your progress across every tier.",
    },
    {
      title: "Intelligence for Every Drop",
      body: "FMV on All Day is built from real sales; an edition with no recent sale is priced from its lowest live ask and marked as such. The sniper scans live All Day listings for moments listed below FMV.",
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
      body: "Pinnacle FMV is priced pin by pin from recent sales; a pin with too few sales is priced from its lowest live ask and marked as such. Deal-finding spans character lines, franchise affiliations, and variant rarity — the sniper flags pins listed below their FMV, across Mickey, Marvel heroes, or Pixar favourites in one view.",
    },
  ],
  "laliga-golazos": [
    {
      title: "Built for Football Intelligence",
      body: "LaLiga Golazos captures the best goals and skills from Spanish football on Flow — the league of Messi, Ronaldo, Lewandowski, and the next generation. RPC tracks every moment across every tier so collectors can measure scarcity against price in the Spanish football market.",
    },
    {
      title: "The Golazos Ecosystem",
      body: "Golazos runs a clean four-tier structure (Legendary, Rare, Uncommon, Fandom) across every edition and set. Because volume is lighter than Top Shot, floor pricing matters — RPC measures relative value against the floor so you can see which moments are priced correctly and which aren't.",
    },
    {
      title: "Deals Relative to Market",
      body: "The Golazos sniper uses relative deal scoring rather than raw FMV discount — comparing each live ask against the edition's recent median sale. A 100x-floor outlier filter keeps stray high asks from distorting the signal.",
    },
  ],
  "candy-mlb": [
    {
      title: "Built for Baseball Collectors",
      body: "Candy MLB brings officially licensed MLB moments on-chain — Solana, under Candy Digital. RPC tracks every edition and prices it from its recent secondary sales, or from a confirmed live ask when it has none — and says which.",
    },
    {
      title: "The Candy Ecosystem",
      body: "Candy runs a compact catalogue — base and ICON series across Common and Legendary tiers — with secondary trading on Magic Eden and OpenSea. Because the set is small, RPC prices every edition from its own recent sales and confirmed asks.",
    },
    {
      title: "What Is Live Here",
      body: "This overview carries the market pulse; the full Candy MLB board (floors, asks, 24h sales, per-edition history) is one tap away below. Binder, Sets, Pack EV and Analytics below read Solana wallets and Candy's own packs.",
    },
  ],
  "panini-blockchain": [
    {
      title: "Panini NFT Cards",
      body: "Panini's digital cards live on Panini's own marketplace. RPC walks it continuously: 2026 Prizm World Cup in full, plus other Panini products (NBA, NFL and more) for the cards that are listed or held by linked collectors. It prices every edition it has seen and tracks the live asks against those prices.",
    },
    {
      title: "What RPC Can and Cannot See",
      body: "Panini publishes no full checklist, so RPC indexes a card only once it has been listed for sale. Every count and price here is a floor, not a census — the coverage note above says how much of the set that covers today.",
    },
    {
      title: "Where the Deep Boards Live",
      body: "The pack squeeze board, deals, pack EV, special serials and player boards are on the Panini WC Prizm board, one tap away below. Market here lists every edition with an ask RPC has confirmed in the last week.",
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
      // ⛔ 2026-10-14: this card used to promise a sniper "catching fight moments
      // priced below market" on a market that closed 13 May 2026 — the About
      // panel the 09-06 closed-market chrome fix did not reach. Guarded in
      // __tests__/closed-market-chrome-makes-no-trading-claim.test.ts.
      title: "A Closed Market, Kept on Record",
      body: "UFC Strike's Flow marketplace closed on 13 May 2026. Every value here is a closing one, built from the sales recorded through the last of them, and the full sales history stays searchable so collectors can still document and value what they hold.",
    },
  ],
}

// ⛔ REMOVED 2026-09-06: a second, DEAD `COLLECTION_TICKER` map lived here —
// a stale per-collection copy of components/collection-chrome.tsx's
// TICKER_ITEMS, with ZERO references anywhere in the tree. It rendered
// nothing, so it was never a live defect; it was worse than one. It still
// carried the trading claims the real ticker was just corrected for, and
// the next session to fix "the overview ticker" would have found it first
// and edited the copy nobody sees. The ticker is components/collection-chrome.tsx.

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

export default function CollectionOverviewClient({
  collection,
  marketCapSlot = null,
  initialStats = null,
}: {
  collection: string
  /** Server-rendered market-cap tile (page.tsx), already wrapped in Suspense. */
  marketCapSlot?: React.ReactNode
  /**
   * Server-seeded stats for the FIRST frame (page.tsx, review E2 2026-10-13).
   * Null when the server read failed or was skipped — then the band loads
   * exactly as before. The live refresh below runs either way, so a seed can
   * only ever be a head start, never the final word on freshness.
   */
  initialStats?: CollectionStats | null
}) {
  const collectionObj = getCollection(collection)
  const accent = collectionObj?.accent ?? "var(--rpc-red)"
  const enabledPages = new Set(collectionObj?.pages ?? [])
  const basePath = "/" + collection

  const [stats, setStats] = useState<CollectionStats | null>(initialStats)
  const [loading, setLoading] = useState(initialStats == null)
  // True for the first effect run only when the server seeded the band: that
  // run refreshes BEHIND the seeded numbers instead of blanking them. A later
  // run (the collection prop changed) loads as before.
  const seededFirstRun = useRef(initialStats != null)
  const [error, setError] = useState<string | null>(null)
  const [timedOut, setTimedOut] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (seededFirstRun.current) seededFirstRun.current = false
    else setLoading(true)
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
  // Thin, non-Flow collections (Candy MLB): FMV is recomputed on each sale, the
  // sniper + insider detectors have no arm for the chain, and the tabs those
  // panels link to do not exist. Each panel below asks for what it needs.
  const saleDrivenFmv = collection === "candy-mlb"
  const hasSniperTab = enabledPages.has("sniper" as never)
  // ⚠ Explicit "flow", not `?? "flow"`: Panini's dbChain is null (no chain
  // identity established), and the old default ran Flow detectors for it.
  // 2026-10-20 sweep: a closed market (UFC Strike, 13 May 2026) rendered "Insider
  // Signals — Anomalies in the last 24h" — a live-trading monitor over a market that
  // has no trades. It is a Flow-chain panel for OPEN markets only.
  const hasInsiderDetectors = (collectionObj ? collectionObj.dbChain === "flow" : true) && !closedMarket(collection)
  // Panini (published 2026-09-25): its 24h sales KPIs stay null (Panini sales
  // reach RPC ~2 days late), its list panels read Panini's own deal snapshot and
  // $100+ sales (2026-10-14, lib/panini/overview-feeds.ts), and every surface
  // carries the listing-gated coverage disclosure. `sales_tracked: false` still
  // means "no sale feed at all" for any collection that sets it.
  const isPanini = collection === "panini-blockchain"
  const salesUntracked = stats?.sales_tracked === false
  // Disney Pinnacle's FMV recomputes twice a day — a 12-hourly cadence, not a fault.
  const twiceDailyFmv = collection === "disney-pinnacle"
  const freshness = freshnessFromAge(fmvAge, showLoading, frozenMarket, saleDrivenFmv ? "sale-driven" : twiceDailyFmv ? "twice-daily" : "continuous")

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
  // A NULL list is "not measured" — it must render as unavailable, never as
  // "No deals". Every Flow arm of get_collection_stats returns an array; only a
  // failed Panini snapshot read nulls it (2026-10-14: before then Panini's was
  // ALWAYS null, and this `?? []` published "No deals ≥15% off right now" beside a
  // Sniper tab listing ~600).
  const sniperDealsUnmeasured = stats != null && stats.sniper_deals == null
  const sniperDeals = stats?.sniper_deals ?? []
  // `?? []` is safe here only because the `salesUntracked` branch below renders
  // BEFORE the empty-state one: a null top_sales never reaches "No sales".
  const rawTopSales = stats?.top_sales ?? []
  // Same rule for sales once the feed IS tracked: a null list is a failed read.
  const topSalesUnmeasured = stats != null && !salesUntracked && stats.top_sales == null
  const topSalesScope = stats?.top_sales_scope ?? null
  const topSalesScopeText = topSalesScope
    ? `$${topSalesScope.min_usd}+ sales indexed in the last ${topSalesScope.days} days`
    : null
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
          value={stats && stats.edition_count != null ? stats.edition_count.toLocaleString() : null}
        />
        {/* Relabelled 2026-08-01 (was "FMV Confidence" / "62% HIGH/MED"). The tile
            printed the internal confidence enum on a public, unauthenticated page —
            the standing no-confidence-UI policy — and "HIGH/MED" is uncalibratable
            for a visitor who has never seen the scale. The underlying number is
            unchanged: the share of this collection's editions whose FMV rests on
            corroborated recent sales rather than an ask or nothing. Relabelled
            rather than deleted, so the KPI row keeps its three cells. */}
        {/* 2026-10-20 sweep: "Priced from Sales | 0%" on /ufc/overview sat beside "Every
            value here is a closing one, built from the sales recorded" — both true only
            once the label says what the share counts: corroborated RECENT sales (a market
            closed five months has none). The tile stays (10-18: a basis fact). */}
        <KpiCard
          label="Priced from Recent Sales"
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
             "Priced from Sales". Null renders an em dash, which says nothing
             rather than something false. Zero is a real value here and still
             renders as "0%". */
          /* #205 (Trevor 2026-10-21, "make it a real sales stat"): the cell now reads
             recent_sale_pct — editions with a market sale in the last 30 days — not the
             HIGH/MEDIUM confidence share, which read 0 % on Golazos beside 84 editions
             sold this month. Still NO fallback: when recent_sale_pct is null (failed or
             stale read) the cell is an em dash, never fmv_high_medium_pct or fmv_pct. */
          value={
            stats && stats.recent_sale_pct != null
              ? `${Math.round(stats.recent_sale_pct)}%`
              : null
          }
        />
        {isPanini ? (
          // Panini's sales are not a tracked feed, so its third cell is the
          // freshness of its prices — a figure RPC actually measures — never a
          // "$0" volume manufactured from feeds that hold no Panini rows.
          <KpiCard
            label="Typical Price Checked"
            accent={accent}
            loading={loading}
            valueColor="var(--rpc-success-text)"
            value={
              stats?.coverage?.edition_age_p50_h != null
                ? fmtAge(Math.round(stats.coverage.edition_age_p50_h * 60))
                : stats
                  ? EM_DASH
                  : null
            }
          />
        ) : (
          <KpiCard
            label="24h Sales Volume"
            accent={accent}
            loading={loading}
            valueColor="var(--rpc-success-text)"
            value={
              stats
                ? stats.volume_24h != null
                  ? // a real sub-$0.50 day is not "$0" (2026-09-28). A zero is "no sale
                    // INDEXED", not "$0 traded" (2026-10-14): Candy read "$0" for three
                    // days while its only keyed feed was quiet and a second venue sat
                    // unindexed. "$0" survives only if the feed reported sales at $0.
                    stats.volume_24h > 0
                    ? fmtPrice(stats.volume_24h)
                    : (stats.sales_24h ?? 0) > 0
                      ? "$0"
                      : "None indexed"
                  : EM_DASH
                : null
            }
          />
        )}
      </div>

      {isPanini && <PaniniCoverageNote coverage={stats?.coverage} failed={stats?.coverage_failed === true || statsUnavailable} />}

      {error && (
        <section className="rpc-card" style={{ padding: "12px 16px", borderLeft: "3px solid #F59E0B" }}>
          <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
            {"Couldn\u2019t load collection stats right now. Data will refresh on next reload."}
          </div>
        </section>
      )}

      {marketCapSlot}

      {/* ── Sniper Deals + Pipeline Status ── */}
      <div className="rpc-ov-2col">

        {/* Top 5 Sniper Deals — only where a sniper arm exists; "No deals right
            now" on a collection with no sniper is a market claim we made up. */}
        {hasSniperTab && (
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">
              {collection === "disney-pinnacle" ? "Cheapest Available Asks" : "Top Sniper Deals"}
            </span>
            <Link href={basePath + "/sniper"} className="rpc-mono rpc-tap44" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>
              View all {"\u2192"}
            </Link>
          </div>
          {loading ? (
            <SkeletonRows />
          ) : statsUnavailable || sniperDealsUnmeasured ? (
            <PanelUnavailable />
          ) : sniperDeals.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", padding: "16px 0", textAlign: "center" }}>
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
                      <div className="rpc-mono" style={{ color: accentText(tierColor(deal.tier, collection)), fontSize: "var(--text-xs)" }}>
                        {deal.tier ?? ""}
                        {deal.set_name ? <> &middot; <span style={{ color: "var(--rpc-text-muted)" }}>{deal.set_name}</span></> : null}
                      </div>
                    </div>
                    <div className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>{askIsSubDollar ? "<$1" : fmtPrice(deal.ask_price)}</div>
                    {hasDiscount && (
                      <div className="rpc-mono" style={{ color: "var(--rpc-red-text)", fontWeight: 700 }}>-{Math.round(deal.discount as number)}%</div>
                    )}
                  </>
                )
                const rowStyle = { display: "grid", gridTemplateColumns: gridCols, gap: 12, padding: "8px 12px", background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", alignItems: "center", textDecoration: "none" } as const
                return deal.buy_url ? (
                  <a
                    key={i}
                    href={deal.buy_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    // get_collection_stats' sniper_deals carry the EDITION key in a
                    // field named flow_id (no moment id), so the click is matched at
                    // edition grain.
                    onClick={() => trackOutboundClick({
                      surface: "collection_overview",
                      collection,
                      linkKind: "listing",
                      destination: "native_listing",
                      editionKey: deal.flow_id ?? null,
                      playerName: deal.player_name ?? deal.character_name ?? null,
                      setName: deal.set_name ?? null,
                      tier: deal.tier ?? null,
                      serial: deal.serial_number ?? null,
                      askPrice: deal.ask_price > 0 ? deal.ask_price : null,
                      fmv: deal.fmv ?? null,
                      discount: deal.discount ?? null,
                      buyUrl: deal.buy_url,
                    })}
                    style={rowStyle}
                  >
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
        )}

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
            {/* Panini (2026-10-14): fmv_age_minutes is the NEWEST price written — the walk reprices a
                few editions every run, so it reads "just now" while the typical edition was checked
                days ago (the KPI tile beside it). Labelled for what it is, with the typical age under it. */}
            <div className="rpc-label" style={{ marginBottom: 4 }}>{isPanini ? "Newest Price Written" : "FMV Data Age"}</div>
            {showLoading ? (
              <div className="rpc-skeleton" style={{ width: "40%", height: 20 }} />
            ) : (
              <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: freshness.color }}>
                {fmtAge(fmvAge)}
              </div>
            )}
            {isPanini && !showLoading && stats?.coverage?.edition_age_p50_h != null && (
              <div className="rpc-mono" data-testid="panini-typical-price-age" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginTop: 4 }}>
                typical edition checked {fmtAge(Math.round(stats.coverage.edition_age_p50_h * 60))}
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 16, justifyContent: "center", marginTop: 14 }}>
            {[
              { tone: "#34D399", label: "< 30 min" },
              { tone: "#F59E0B", label: "30\u201360 min" },
              { tone: "var(--rpc-red)", label: "> 60 min" },
            ].map((item) => (
              <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: item.tone }} />
                <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{item.label}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ── Insider Signals (anomaly detection across sales activity) ── */}
      {hasInsiderDetectors && <InsiderSignalsPanel collection={collection} basePath={basePath} />}

      {/* ── Recent Top Sales + About the Community ── */}
      <div className="rpc-ov-2col">

        {/* Recent Top Sales */}
        <section className="rpc-card" style={{ padding: "16px 20px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--tier-legendary)" }} />
            <span className="rpc-label">Recent Top Sales</span>
            <Link href={isPanini ? basePath + "/analytics" : hasSniperTab ? basePath + "/sniper" : collection === "candy-mlb" ? "/insights/candy-mlb" : basePath + "/overview"} className="rpc-mono rpc-tap44" style={{ marginLeft: "auto", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", textDecoration: "none" }}>
              View all {"\u2192"}
            </Link>
          </div>
          {loading ? (
            <SkeletonRows />
          ) : statsUnavailable ? (
            <PanelUnavailable />
          ) : salesUntracked ? (
            // Not "No sales": RPC has no complete sale feed for this collection,
            // so an empty list here is a fact about us, not about the market.
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", padding: "16px 0", textAlign: "center" }}>
              Sales aren&rsquo;t a tracked feed for this collection yet
            </div>
          ) : topSalesUnmeasured ? (
            <PanelUnavailable />
          ) : rawTopSales.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", padding: "16px 0", textAlign: "center" }}>
              {topSalesScopeText ? `No ${topSalesScopeText}` : "No sales indexed in the last 24h"}
            </div>
          ) : topSales.length === 0 ? (
            // Read succeeded and the market traded — we just can't name any of
            // it. Saying "no sales" here would be a false claim about the
            // market; this says the true thing, which is about our catalog.
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", padding: "16px 0", textAlign: "center" }}>
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
                        {sale.tier && <span style={{ color: accentText(tierColor(sale.tier, collection)) }}>{sale.tier}</span>}
                        {sale.set_name && <>{sale.tier ? " \u00B7 " : ""}{sale.set_name}</>}
                        {serialDisplay && <> &middot; {serialDisplay}</>}
                        {ageMin != null && <> &middot; {fmtAge(ageMin)}</>}
                      </div>
                    </div>
                    <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", color: "var(--rpc-success-text)", textAlign: "right" }}>
                      {fmtPrice(sale.price)}
                    </div>
                  </div>
                )
              })}
              {topSalesScopeText && (
                <div className="rpc-mono" data-testid="top-sales-scope" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", paddingTop: 2 }}>
                  {topSalesScopeText}
                </div>
              )}
              {unnamedTopSales > 0 && (
                <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", paddingTop: 2 }}>
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
                <div style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", lineHeight: 1.7 }}>
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
                Optimal Top Shot Fast Break lineup from player projections · public, no signup
              </span>
            </div>
            <Link
              href="/nba/fast-break"
              className="rpc-mono"
              style={{
                fontSize: "var(--text-xs)",
                color: "var(--rpc-red-text)",
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
            Every edition with its floor, best ask, FMV and 24h sales — the full Candy MLB intelligence board.
          </div>
          <Link href="/insights/candy-mlb" className="rpc-heading" style={{ display: "inline-block", padding: "10px 18px", background: accent, color: "#0B0B0D", borderRadius: 6, fontSize: "var(--text-sm)", letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
            Open the Candy MLB board →
          </Link>
        </section>
      )}

      {isPanini && (
        <section className="rpc-card" style={{ padding: "16px 20px", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: accent, opacity: 0.7 }} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: accent }} />
            <span className="rpc-label">Panini WC Prizm board</span>
          </div>
          <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
            Which cards are still sealed in packs, deals against FMV, pack EV, special serials and the player board — under the same coverage note.
          </div>
          <Link href="/insights/panini-squeeze" className="rpc-heading" style={{ display: "inline-block", padding: "10px 18px", background: accent, color: "#0B0B0D", borderRadius: 6, fontSize: "var(--text-sm)", letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none" }}>
            Open the Panini boards →
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
            // ⛔ The descriptions are DERIVED, not literals. Two of them were
            // asserting a trading venue on /ufc/overview, whose market closed
            // 13 May 2026 — measured in production, not inferred. toolCardDesc()
            // also absorbs the Pinnacle listing-feed override that used to be an
            // inline ternary here. The old strings are quoted in
            // lib/collection/closed-market-chrome.ts, which carries the case
            // history; they are deliberately NOT repeated in this file, because
            // the guard bans them from this source.
            { label: "Binder", desc: toolCardDesc("collection", collection), icon: "\u25C8", tone: accent,                  page: "collection" },
            { label: "Pack EV",   desc: toolCardDesc("packs", collection),      icon: "\u25A3", tone: "var(--tier-legendary)", page: "packs" },
            { label: "Sniper",    desc: toolCardDesc("sniper", collection),     icon: "\u26A1", tone: "#34D399",                page: "sniper" },
            { label: "Sets",      desc: toolCardDesc("sets", collection),       icon: "\u25C9", tone: "#F472B6",                page: "sets" },
            { label: "Analytics", desc: toolCardDesc("analytics", collection),  icon: "\u25CE", tone: "#A78BFA",                page: "analytics" },
            { label: "Market",    desc: toolCardDesc("market", collection),     icon: "\u25C8", tone: "var(--tier-rare)",      page: "market" },
          ].filter((t) => enabledPages.has(t.page as never)).map(({ label, desc, icon, tone, page }) => (
            <Link key={page} href={basePath + "/" + page} style={{ textDecoration: "none" }}>
              <div className="rpc-card" style={{ padding: "14px 16px", cursor: "pointer", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 2, background: tone, opacity: 0.5 }} />
                <div style={{ fontSize: 18, marginBottom: 7, color: tone }}>{icon}</div>
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
      {/* 2026-10-11: a null value is UNKNOWN, not loading — a skeleton that never
          resolves reads as "still loading" forever after a failed read. */}
      {loading ? (
        <div className="rpc-skeleton" style={{ width: "50%", height: 20 }} />
      ) : (
        <div className="rpc-heading" style={{ fontSize: "var(--text-xl)", color: value == null ? "var(--rpc-text-muted)" : accentText(valueColor) }}>
          {value ?? "\u2014"}
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
    <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", padding: "16px 0", textAlign: "center" }}>
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
