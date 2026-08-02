"use client";

// Presentational filter-controls region for the collection sniper page
// (app/(collections)/[collection]/sniper/page.tsx). Behavior-preserving verbatim
// extraction of the primary-filters row, the tier/variant quick tabs, and the
// advanced-filters row. All state stays in the page; this component reads values
// and reports changes through the callback props below. No data-fetch logic here.
import LeagueFilter, { type LeagueValue } from "@/components/filters/LeagueFilter";
import { variantColor } from "@/lib/sniper/helpers";
import type { SortOption } from "@/lib/sniper/types";

export default function SniperFilterBar(props: {
  isMobile: boolean;
  isPinnacle: boolean;
  isAllDay: boolean;
  isGolazos: boolean;
  accent: string;
  collectionSlug: string;
  showFilters: boolean;
  onToggleFilters: () => void;
  playerInput: string;
  onPlayerChange: (value: string) => void;
  tierTab: string;
  tabs: readonly string[];
  onTierChange: (t: string) => void;
  minDiscount: number;
  onMinDiscountChange: (n: number) => void;
  maxPrice: number;
  onMaxPriceChange: (n: number) => void;
  search: string;
  onSearchChange: (value: string) => void;
  serialFilter: string;
  onSerialChange: (value: string) => void;
  sortBy: SortOption;
  sortOptions: { value: SortOption; label: string }[];
  onSortChange: (value: SortOption) => void;
  badgeOnly: boolean;
  onBadgeOnlyChange: (b: boolean) => void;
  showVerifiedOnly: boolean;
  onVerifiedChange: (b: boolean) => void;
  ownedFilter: "all" | "owned" | "not-owned";
  onOwnedFilterChange: (value: "all" | "owned" | "not-owned") => void;
  ownedCount: number;
  leagueFilter: LeagueValue;
  onLeagueChange: (value: LeagueValue) => void;
  saveSearchMsg: string | null;
  onSaveSearch: () => void;
}) {
  const {
    isMobile, isPinnacle, isAllDay, isGolazos, accent, collectionSlug,
    showFilters, onToggleFilters,
    playerInput, onPlayerChange,
    tierTab, tabs, onTierChange,
    minDiscount, onMinDiscountChange,
    maxPrice, onMaxPriceChange,
    search, onSearchChange,
    serialFilter, onSerialChange,
    sortBy, sortOptions, onSortChange,
    badgeOnly, onBadgeOnlyChange,
    showVerifiedOnly, onVerifiedChange,
    ownedFilter, onOwnedFilterChange, ownedCount,
    leagueFilter, onLeagueChange,
    saveSearchMsg, onSaveSearch,
  } = props;

  return (
    <>
      {/* ── Primary Filters (Player input, Min Discount %) — hidden on mobile when filters collapsed ── */}
      {(!isMobile || showFilters) && (
      <div className={isMobile ? "flex flex-col gap-3 mb-4" : "flex flex-wrap items-center gap-3 mb-4"} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
        <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)" }}>
          <span>{isPinnacle ? "CHARACTER" : "PLAYER"}</span>
          <input
            type="text"
            placeholder={isPinnacle ? "e.g. Grogu" : "e.g. LeBron"}
            value={playerInput}
            onChange={(e) => onPlayerChange(e.target.value)}
            style={{ width: isMobile ? "100%" : 160, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
          />
        </label>
        {!isAllDay && (
        <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)" }}>
          <span>MIN DISC.</span>
          <input
            type="number"
            min={0} max={100} step={5}
            value={minDiscount}
            onChange={(e) => onMinDiscountChange(Number(e.target.value))}
            placeholder="0"
            style={{ width: 56, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
          />
          <span>%</span>
        </label>
        )}
        <LeagueFilter value={leagueFilter} onChange={onLeagueChange} visible={collectionSlug === "nba-top-shot"} />
      </div>
      )}

      {/* Tier / Variant quick tabs */}
      <div className="flex items-center gap-1 mb-4 flex-wrap">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => onTierChange(t)}
            className={`rpc-chip min-h-[44px] ${tierTab === t ? "active" : ""}`}
            style={tierTab === t
              ? { textTransform: "uppercase", background: `${accent}1A`, borderColor: `${accent}66`, color: isPinnacle && t !== "all" ? variantColor(t) : accent }
              : { textTransform: "uppercase" }}
          >
            {t}
          </button>
        ))}
        {isMobile && (
          <button
            onClick={onToggleFilters}
            className="rpc-chip min-h-[44px]"
            style={showFilters ? { background: `${accent}1A`, borderColor: `${accent}66`, color: accent } : undefined}
          >
            {"⚙ FILTERS" + (function() {
              let count = 0;
              if (minDiscount > 0) count++;
              if (maxPrice > 0) count++;
              if (search.length > 0) count++;
              if (badgeOnly) count++;
              return count > 0 ? " (" + count + ")" : "";
            })()}
          </button>
        )}
      </div>

      {/* Advanced Filters — always visible on desktop, collapsible on mobile */}
      {(!isMobile || showFilters) && (
      <div className={isMobile ? "flex flex-col gap-3 mb-4" : "flex flex-wrap items-center gap-3"} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
        <input
          type="text"
          placeholder="Search player, set, team…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", width: 200, outline: "none" }}
        />
        <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
          <span>MAX $</span>
          <input
            type="number"
            min={0} step={1}
            value={maxPrice || ""}
            onChange={(e) => onMaxPriceChange(Number(e.target.value))}
            placeholder="any"
            style={{ width: 72, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
          />
        </label>
        {/* SPECIAL-SERIAL SELECT REMOVED 2026-08-01 - it could not be satisfied
            on ANY collection, so it was a control that visibly did nothing.
              * Top Shot: the board is served by get_topshot_sniper_deals, which
                is EDITION-level - serial_number is NULL on 200/200 rows live,
                so no row can ever be a "special serial". (Its per-listing
                source, ts_listings, is a dead table: 1 row, frozen 2026-05-15.)
              * All Day / Pinnacle / Golazos / UFC: `serialFilter` was never
                even passed to their compute functions in
                app/api/sniper-feed/route.ts, so it was a no-op by construction.
            Restoring it needs a real per-listing Top Shot source (the retired
            topshot-listings-indexer, or a serial-aware RPC). The `serial`
            query param is still honoured server-side and now honestly returns
            nothing rather than silently ignoring the filter. The
            serialFilter/onSerialChange props are intentionally retained so
            re-enabling is a UI-only change. */}
        <select
          value={sortBy}
          onChange={(e) => onSortChange(e.target.value as SortOption)}
          style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
        >
          {sortOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        {/* All Day has no badge system, so the toggle and downstream
            badge stats are hidden for nfl-all-day (same as Pinnacle). */}
        {!isPinnacle && !isAllDay && (
        <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
          <input
            type="checkbox"
            checked={badgeOnly}
            onChange={(e) => onBadgeOnlyChange(e.target.checked)}
          />
          BADGES ONLY
        </label>
        )}
        <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
          <input
            type="checkbox"
            checked={showVerifiedOnly}
            onChange={(e) => onVerifiedChange(e.target.checked)}
          />
          <span className="inline-flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
            VERIFIED FMV ONLY
          </span>
        </label>
        {!isAllDay && ownedCount > 0 && (
          <select
            value={ownedFilter}
            onChange={(e) => onOwnedFilterChange(e.target.value as "all" | "owned" | "not-owned")}
            className="rpc-chip"
            title="Filter by whether you own this edition"
            style={{
              background: ownedFilter !== "all" ? "rgba(0,232,130,0.10)" : undefined,
              borderColor: ownedFilter !== "all" ? "rgba(0,232,130,0.40)" : undefined,
              color: ownedFilter !== "all" ? "#00e882" : undefined,
            }}
          >
            <option value="all">ALL</option>
            <option value="not-owned">NOT OWNED</option>
            <option value="owned">OWNED</option>
          </select>
        )}
        {/* Task 5: Save Search button */}
        <button
          onClick={onSaveSearch}
          className="rpc-chip"
          title="Save current filter state to your watchlist"
          style={{ marginLeft: "auto" }}
        >
          {saveSearchMsg ?? "💾 SAVE SEARCH"}
        </button>
      </div>
      )}
    </>
  );
}
