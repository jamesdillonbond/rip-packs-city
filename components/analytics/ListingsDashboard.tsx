"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import Link from "next/link"
import {
  BarChart3,
  ChevronDown,
  ChevronUp,
  HandCoins,
  Info,
  Sigma,
  Tag,
  TimerReset,
} from "lucide-react"
import KpiCard from "./KpiCard"
import type {
  ListingsOpenLoanOfferRow,
  ListingsSummaryResponse,
} from "@/lib/analytics-types"
import {
  SORT_OPTIONS,
  formatUsd,
  formatPrice,
  formatNumber,
  formatPct,
  relativeTime,
  truncateAddr,
  isLinkableAddr,
  resolveCollectionLabel,
  resolveSortOption,
  isSparseListingCount,
  normalizeMarketplaceListings,
} from "@/lib/analytics-listings-compute"

const ALL_COLLECTIONS = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "Golazos" },
  { key: "ufc", label: "UFC Strike" },
  { key: "pinnacle", label: "Pinnacle" },
]

interface LoanOffersResponse {
  rows: ListingsOpenLoanOfferRow[]
  sort: string
}

export default function ListingsDashboard() {
  const [activeCollections, setActiveCollections] = useState<string[]>([])
  const [sort, setSort] = useState<string>("apr_desc")
  const [sortOpen, setSortOpen] = useState(false)
  const sortMenuRef = useRef<HTMLDivElement | null>(null)
  const [showCaveats, setShowCaveats] = useState(false)

  const [summary, setSummary] = useState<ListingsSummaryResponse | null>(null)
  const [offers, setOffers] = useState<LoanOffersResponse | null>(null)
  const [loading, setLoading] = useState(true)
  // Per LEG: the two reads back two different tables, and a loan-offers outage
  // must not blank the marketplace snapshot that loaded fine.
  const [loadFailed, setLoadFailed] = useState({ summary: false, offers: false })

  const collectionsQs = useMemo(
    () => (activeCollections.length > 0 ? activeCollections.join(",") : ""),
    [activeCollections]
  )

  // Keyboard/click-outside dismissal for the sort dropdown, which previously
  // closed only on mouse-leave — a keyboard user could not dismiss it without
  // committing to a selection. Close on Escape and on an outside click.
  useEffect(() => {
    if (!sortOpen) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSortOpen(false)
    }
    function onDocClick(e: MouseEvent) {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener("keydown", onKey)
    document.addEventListener("mousedown", onDocClick)
    return () => {
      document.removeEventListener("keydown", onKey)
      document.removeEventListener("mousedown", onDocClick)
    }
  }, [sortOpen])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const summaryQs = new URLSearchParams()
    if (collectionsQs) summaryQs.set("collections", collectionsQs)

    const offersQs = new URLSearchParams(summaryQs)
    offersQs.set("sort", sort)
    offersQs.set("limit", "25")

    setLoadFailed({ summary: false, offers: false })

    // ⚠ Was `fetch(...).then((r) => r.json())` with NO `r.ok` check. These routes
    // answer a failure with a well-formed JSON envelope (`apiErrorResponse`), so
    // `r.json()` SUCCEEDS, the `.catch` never fires, and the error object was
    // cast straight to the success type — after which `?.rows` reads undefined
    // and the table states "No open offers match the current filters."
    // fetchJson gates the parse on the status, which is exactly what its own
    // header says it exists to do.
    Promise.all([
      fetchJson<ListingsSummaryResponse>(`/api/analytics/listings/summary?${summaryQs.toString()}`),
      fetchJson<LoanOffersResponse>(`/api/analytics/listings/loan-offers?${offersQs.toString()}`),
    ])
      .then(([s, o]) => {
        if (cancelled) return
        setLoadFailed({ summary: !s.ok, offers: !o.ok })
        setSummary(s.json)
        setOffers(o.json)
      })
      .catch(() => {
        // fetchJson never rejects, so this only catches a programming fault.
        if (!cancelled) setLoadFailed({ summary: true, offers: true })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [collectionsQs, sort])

  function toggleCollection(key: string) {
    setActiveCollections((curr) =>
      curr.includes(key) ? curr.filter((c) => c !== key) : [...curr, key]
    )
  }

  const loanOffers = summary?.loan_offers
  // summary.topshot_orderbook is still returned by /api/analytics/listings/summary
  // but is deliberately NOT rendered: it aggregates `ts_listings`, a table retired
  // 2026-05-26 that holds one row from 2026-05-15 (deep-audit D12). Left in the API
  // response so removing it stays a separate, reviewable change.
  // Audit 2026-05-20: analytics_listings_summary RPC can return marketplace_listings
  // as {} (not []) when empty; ?? [] only catches null/undefined, so .map would throw.
  const marketplace = normalizeMarketplaceListings(summary?.marketplace_listings)
  const sortOption = resolveSortOption(sort)

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5">
        <div>
          <h1 className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tracking-tight">
            Listings — Open Offers and Orderbook
          </h1>
          <p className="text-sm text-[color:var(--rpc-text-secondary)] mt-1 max-w-2xl">
            Active loan offers, plus per-collection ask snapshots from the Sniper deal feed
            (low-price-biased, not full orderbook depth). The Top Shot orderbook sampler is retired —
            see the note in that section.
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveCollections([])}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (activeCollections.length === 0
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
            }
          >
            All collections
          </button>
          {ALL_COLLECTIONS.map((c) => {
            const active = activeCollections.includes(c.key)
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCollection(c.key)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                  (active
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    : "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
                }
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Open loan offers — KPI strip */}
      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Open loan offers</h2>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">Liquidity awaiting borrowers across all collections</p>
        </div>
        <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Open offers"
            value={loanOffers ? formatNumber(loanOffers.count) : "—"}
            sublabel="Across all collections"
            icon={HandCoins}
            accent="emerald"
          />
          <KpiCard
            label="Total liquidity"
            value={loanOffers ? formatUsd(loanOffers.total_principal_usd) : "—"}
            sublabel={
              loanOffers?.avg_principal_usd != null
                ? `Avg ${formatUsd(loanOffers.avg_principal_usd)}`
                : undefined
            }
            icon={Sigma}
            accent="emerald"
          />
          <KpiCard
            label="Avg APR"
            value={
              loanOffers?.avg_apr != null
                ? formatPct(loanOffers.avg_apr * 100)
                : "—"
            }
            sublabel="Annualized rate"
            icon={Tag}
            accent="amber"
          />
          <KpiCard
            label="Avg term"
            value={
              loanOffers?.avg_term_days != null
                ? `${loanOffers.avg_term_days.toFixed(0)}d`
                : "—"
            }
            sublabel="Days until maturity"
            icon={TimerReset}
            accent="sky"
          />
        </div>
      </section>

      {/* Open loan offers — table */}
      <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div>
            <h3 className="text-sm font-semibold text-[color:var(--rpc-text-primary)]">Top 25 open offers</h3>
            <p className="text-xs text-[color:var(--rpc-text-muted)]">{sortOption.caption}</p>
          </div>
          <div className="relative flex-shrink-0" ref={sortMenuRef}>
            <button
              type="button"
              onClick={() => setSortOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={sortOpen}
              className="flex items-center gap-2 rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-3 py-2 text-sm text-[color:var(--rpc-text-primary)] hover:border-emerald-500/50 transition-colors"
            >
              <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
                Sort
              </span>
              <span>{sortOption.label}</span>
              <ChevronDown size={14} className="text-[color:var(--rpc-text-muted)]" />
            </button>
            {sortOpen ? (
              <div
                className="absolute right-0 top-full mt-1 z-20 w-56 rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] shadow-xl"
                onMouseLeave={() => setSortOpen(false)}
              >
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => {
                      setSort(o.value)
                      setSortOpen(false)
                    }}
                    className={
                      "block w-full text-left px-3 py-1.5 text-sm transition-colors " +
                      (o.value === sort
                        ? "text-emerald-400 bg-emerald-500/10"
                        : "text-[color:var(--rpc-text-secondary)] hover:bg-[color:var(--rpc-surface-hover)]")
                    }
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold border-b border-[color:var(--rpc-border)]">
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Collection</th>
                <th className="py-2 pr-3 text-right">Principal</th>
                <th className="py-2 pr-3 text-right">APR</th>
                <th className="py-2 pr-3 text-right">Term</th>
                <th className="py-2 pr-3">NFT ID</th>
                <th className="py-2 pr-3">Borrower</th>
                <th className="py-2 pr-3">Listed</th>
                <th className="py-2 pr-0 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {(offers?.rows ?? []).length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
                    {loading
                      ? "Loading offers…"
                      : loadFailed.offers
                        ? "Couldn't load open offers just now — this says nothing about what's listed."
                        : "No open offers match the current filters."}
                  </td>
                </tr>
              ) : (
                (offers?.rows ?? []).map((row, i) => {
                  const collectionLabel = resolveCollectionLabel(row.collection)
                  return (
                    <tr
                      key={String(row.listing_resource_id) + "-" + i}
                      className="border-b border-[color:var(--rpc-border-subtle)] hover:bg-[color:var(--rpc-surface-hover)] transition-colors"
                    >
                      <td className="py-2 pr-3 text-[color:var(--rpc-text-muted)] tabular-nums">{i + 1}</td>
                      <td className="py-2 pr-3">
                        <span className="rounded border border-[color:var(--rpc-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]">
                          {collectionLabel}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-primary)] font-semibold tabular-nums">
                        {formatUsd(row.principal_usd)}
                      </td>
                      <td className="py-2 pr-3 text-right text-emerald-400 tabular-nums">
                        {row.apr_pct != null ? `${Number(row.apr_pct).toFixed(0)}%` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                        {row.term_days != null ? `${row.term_days}d` : "—"}
                      </td>
                      <td className="py-2 pr-3 text-[color:var(--rpc-text-secondary)] font-mono text-xs">
                        {row.nft_id != null ? String(row.nft_id) : "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {row.borrower_addr ? (
                          <div className="flex flex-col leading-tight">
                            {isLinkableAddr(row.borrower_addr) ? (
                              <Link
                                href={`/analytics/wallets/${row.borrower_addr}`}
                                className="font-mono text-xs text-[color:var(--rpc-text-secondary)] hover:text-emerald-400 transition-colors"
                              >
                                {truncateAddr(row.borrower_addr)}
                              </Link>
                            ) : (
                              <span className="font-mono text-xs text-[color:var(--rpc-text-muted)]">
                                {truncateAddr(row.borrower_addr)}
                              </span>
                            )}
                            {row.borrower_inferred && row.storefront_address ? (
                              <span className="font-mono text-[10px] italic text-[color:var(--rpc-text-muted)] mt-0.5">
                                via {truncateAddr(row.storefront_address)}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span
                            className="font-mono text-xs text-[color:var(--rpc-text-muted)] cursor-help"
                            title="Lister account hasn't been seen as a borrower elsewhere yet — wallet identity will resolve on first funded loan"
                          >
                            via {truncateAddr(row.storefront_address)}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-3 text-[color:var(--rpc-text-muted)] text-xs">
                        {relativeTime(row.listed_at)}
                      </td>
                      <td className="py-2 pr-0 text-right">
                        <span className="text-[10px] uppercase tracking-wider text-[color:var(--rpc-text-ghost)]">
                            —
                          </span>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Top Shot orderbook */}
      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Top Shot orderbook</h2>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">Retired feed — see note below</p>
        </div>

        {/* ⚠ RETIRED FEED — deep-audit D12.
            This section used to render 5 KPI cards (count / min / median / p90 /
            max ask) computed from `ts_listings`. That table was retired with the
            Top Shot listings-indexer on 2026-05-26: it holds exactly ONE row,
            last written 2026-05-15. So every one of those figures was a
            percentile over a single 86-day-old row — fabricated market data.

            The banner made it worse rather than disclosing it: it told the
            reader the table "holds a periodically-refreshed sample… typically
            100-200 listings", so a visitor seeing "1" concluded the Top Shot
            market had one listing rather than that the feed had been dead for
            three months. A stale disclosure converts a dead feed into an
            apparently-live market reading.

            The rest of the app already knew: edition/[slug]/page.tsx:500 and
            moment/[id]/page.tsx:1380 render an em-dash instead of a fake 0%,
            and SniperFilterBar.tsx:157 states plainly that it "is a dead table:
            1 row, frozen 2026-05-15". This panel was simply missed.

            Live Top Shot ask data is in `badge_editions` (4,541 editions with
            low_ask > 0) and is what the Market and Sniper tabs read. */}
        <div className="rounded-lg border border-amber-900/30 bg-amber-950/20 p-3 flex items-start gap-2 mb-3">
          <Info size={14} className="text-amber-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-[color:var(--rpc-text-secondary)] leading-relaxed">
            <strong>This feed is retired.</strong> The{" "}
            <code className="font-mono text-amber-300">ts_listings</code> sampler was switched off on
            2026-05-26 and its last row was written on 2026-05-15, so no orderbook depth is shown here
            rather than a figure derived from a single stale row. Live Top Shot ask data is on the{" "}
            <strong>Market</strong> and <strong>Sniper</strong> tabs.
          </p>
        </div>
      </section>

      {/* Marketplace listings (sniper sampled) */}
      <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5">
        <div className="mb-3">
          <h3 className="text-sm font-semibold text-[color:var(--rpc-text-primary)]">Marketplace listings (Sniper sampled)</h3>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">
            Per-collection ask snapshots from the deal-feed scanner
          </p>
        </div>

        <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-bg)] p-3 flex items-start gap-2 mb-4">
          <Info size={14} className="text-[color:var(--rpc-text-secondary)] flex-shrink-0 mt-0.5" />
          <p className="text-xs text-[color:var(--rpc-text-secondary)] leading-relaxed">
            Cached listing data is sourced from our Sniper deal feed, which scans for below-FMV
            inventory across collections. Median ask is more representative than max — the feed
            catches deals, not full orderbook depth.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold border-b border-[color:var(--rpc-border)]">
                <th className="py-2 pr-3">Collection</th>
                <th className="py-2 pr-3 text-right">Listings sampled</th>
                <th className="py-2 pr-3 text-right">Min ask</th>
                <th className="py-2 pr-3 text-right">Median ask</th>
                <th className="py-2 pr-0 text-right">Max ask</th>
              </tr>
            </thead>
            <tbody>
              {marketplace.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
                    {loading
                      ? "Loading marketplace data…"
                      : loadFailed.summary
                        ? "Couldn't load marketplace data just now — this says nothing about the market."
                        : "No marketplace data."}
                  </td>
                </tr>
              ) : (
                marketplace.map((row) => {
                  const collectionLabel = resolveCollectionLabel(row.collection)
                  const sparse = isSparseListingCount(row.count)
                  return (
                    <tr
                      key={row.collection}
                      className="border-b border-[color:var(--rpc-border-subtle)] hover:bg-[color:var(--rpc-surface-hover)] transition-colors"
                    >
                      <td className="py-2 pr-3">
                        <span className="text-[color:var(--rpc-text-primary)] font-medium">{collectionLabel}</span>
                        {sparse ? (
                          <span className="ml-2 rounded border border-amber-700/50 bg-amber-950/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-amber-400">
                            Sparse
                          </span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                        {formatNumber(row.count)}
                      </td>
                      <td className="py-2 pr-3 text-right text-emerald-400 tabular-nums">
                        {formatPrice(row.min_ask_usd)}
                      </td>
                      <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-primary)] tabular-nums">
                        {formatPrice(row.median_ask_usd)}
                      </td>
                      <td className="py-2 pr-0 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                        {formatPrice(row.max_ask_usd)}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* About this data — caveats expandable */}
      {summary?.data_caveats && summary.data_caveats.length > 0 ? (
        <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5">
          <button
            type="button"
            onClick={() => setShowCaveats((s) => !s)}
            className="flex items-center justify-between w-full text-left"
          >
            <div className="flex items-center gap-2">
              <Info size={14} className="text-[color:var(--rpc-text-secondary)]" />
              <h3 className="text-sm font-semibold text-[color:var(--rpc-text-primary)]">About this data</h3>
            </div>
            {showCaveats ? (
              <ChevronUp size={14} className="text-[color:var(--rpc-text-muted)]" />
            ) : (
              <ChevronDown size={14} className="text-[color:var(--rpc-text-muted)]" />
            )}
          </button>
          {showCaveats ? (
            <ul className="mt-3 space-y-1.5 text-xs text-[color:var(--rpc-text-secondary)] leading-relaxed list-disc pl-4">
              {summary.data_caveats.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <footer className="flex flex-wrap items-center gap-3 text-xs text-[color:var(--rpc-text-muted)] pt-2 border-t border-[color:var(--rpc-border)]">
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          Refreshes every 5 min
        </span>
        <span className="text-[color:var(--rpc-text-ghost)]">·</span>
        <Link
          href="/analytics/methodology/listings"
          className="hover:text-emerald-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
        </Link>
        {summary?.as_of ? (
          <>
            <span className="text-[color:var(--rpc-text-ghost)]">·</span>
            <span>As of {relativeTime(summary.as_of)}</span>
          </>
        ) : null}
      </footer>
    </div>
  )
}
