"use client"

// PackFilterBar — search, sort, winners / losers and tier chips over a wallet's pack list
// (Trevor 2026-11-26: "add more filters within the packs section within my binder"). Shared by
// the binder's Packs tabs (WalletPacksView) and the full pack history (/dashboard/packs). The
// filters are applied by get_wallet_pack_history v38 before the page; this only collects them.

import { accentFill, labelOn } from "@/lib/accent-text"
import {
  packSortsFor,
  PACK_OUTCOMES,
  packSortLabel,
  packOutcomeLabel,
  packOutcomeHint,
  packTierLabel,
  type PackFilter,
  type PackSort,
  type PackOutcome,
  type PackFilterState,
} from "@/lib/packs-wallet-view-format"

const mono = "var(--font-mono)"

export default function PackFilterBar({
  tab, accent, filters, searchInput, onSearchInput, onChange, tiers, matched, tabTotal, onClear, countNoun = "packs",
}: {
  tab: PackFilter | "all"
  /** What the "N of M …" line counts, e.g. "sealed packs". */
  countNoun?: string
  accent: string
  filters: PackFilterState
  searchInput: string
  onSearchInput: (v: string) => void
  onChange: (patch: Partial<PackFilterState>) => void
  tiers: { tier: string; count: number }[]
  matched: number | null
  tabTotal: number | null
  onClear: () => void
}) {
  const chip = (on: boolean): React.CSSProperties => ({
    fontFamily: mono,
    fontSize: 11,
    padding: "5px 10px",
    minHeight: 30,
    borderRadius: 999,
    cursor: "pointer",
    whiteSpace: "nowrap",
    background: on ? accentFill(accent) : "transparent",
    color: on ? labelOn(accent) : "var(--rpc-text-secondary)",
    border: `1px solid ${on ? accent : "var(--rpc-border)"}`,
  })
  const field: React.CSSProperties = {
    fontFamily: mono,
    fontSize: 12,
    minHeight: 34,
    padding: "6px 10px",
    borderRadius: 4,
    background: "var(--rpc-surface)",
    color: "var(--rpc-text-primary)",
    border: "1px solid var(--rpc-border)",
  }
  return (
    <section aria-label="Filter packs" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="search"
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          placeholder="Search pack name"
          aria-label="Search pack name"
          maxLength={80}
          data-testid="pack-search"
          style={{ ...field, flex: "1 1 200px", minWidth: 0 }}
        />
        <select
          value={filters.sort}
          onChange={(e) => onChange({ sort: e.target.value as PackSort })}
          aria-label="Sort packs"
          data-testid="pack-sort"
          style={{ ...field, flex: "0 1 auto", cursor: "pointer" }}
        >
          {packSortsFor(tab).map((s) => <option key={s} value={s}>{packSortLabel(tab, s)}</option>)}
        </select>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <span role="group" aria-label="Winners or losers" title={packOutcomeHint(tab)} style={{ display: "inline-flex", gap: 6 }}>
          {PACK_OUTCOMES.map((o: PackOutcome) => (
            <button key={o} type="button" aria-pressed={filters.outcome === o} onClick={() => onChange({ outcome: o })} style={chip(filters.outcome === o)}>
              {packOutcomeLabel(o)}
            </button>
          ))}
        </span>
        {tiers.length > 1 && (
          <span role="group" aria-label="Pack tier" style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", marginLeft: 4, paddingLeft: 10, borderLeft: "1px solid var(--rpc-border)" }}>
            {tiers.map(({ tier, count }) => {
              const on = filters.tier === tier
              return (
                <button key={tier} type="button" aria-pressed={on} onClick={() => onChange({ tier: on ? null : tier })} style={chip(on)}>
                  {packTierLabel(tier)} <span style={{ opacity: 0.7 }}>{count.toLocaleString("en-US")}</span>
                </button>
              )
            })}
          </span>
        )}
        {matched != null && (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8, alignItems: "center", fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)" }}>
            <span data-testid="pack-filter-count">
              {matched.toLocaleString("en-US")}{tabTotal != null ? ` of ${tabTotal.toLocaleString("en-US")}` : ""} {countNoun}
            </span>
            <button type="button" className="rpc-chip" onClick={onClear}>Clear</button>
          </span>
        )}
      </div>
    </section>
  )
}
