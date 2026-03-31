import { collectionPageMetadata } from "@/lib/seo"

export function generateMetadata({ params }: { params: { collection: string } }) {
  return collectionPageMetadata(params.collection, "sniper")
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useCart } from "@/lib/cart/CartContext";

// ─── Constants ────────────────────────────────────────────────────────────────
const COMMISSION_RECIPIENT = "0xc1e4f4f4c4257510";
const ACCENT = "#E03A2F";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SniperDeal {
  flowId: string;
  momentId: string;
  editionKey: string;
  playerName: string;
  teamName: string;
  setName: string;
  seriesName: string;
  tier: string;
  parallel: string;
  parallelId: number;
  serial: number;
  circulationCount: number;
  askPrice: number;
  baseFmv: number;
  adjustedFmv: number;
  wapUsd: number | null;
  daysSinceSale: number | null;
  salesCount30d: number | null;
  discount: number;
  confidence: string;
  confidenceSource?: string;
  hasBadge: boolean;
  badgeSlugs: string[];
  badgeLabels: string[];
  badgePremiumPct: number;
  serialMult: number;
  isSpecialSerial: boolean;
  isJersey: boolean;
  serialSignal: string | null;
  thumbnailUrl: string | null;
  isLocked: boolean;
  updatedAt: string | null;
  packListingId: string | null;
  packName: string | null;
  packEv: number | null;
  packEvRatio: number | null;
  buyUrl: string;
  listingResourceID: string | null;
  storefrontAddress: string | null;
  source?: "topshot" | "flowty";
}

interface FeedResult {
  count: number;
  tsCount?: number;
  flowtyCount?: number;
  lastRefreshed: string;
  deals: SniperDeal[];
}

type SortOption =
  | "discount"
  | "price_asc"
  | "price_desc"
  | "fmv_desc"
  | "serial_asc";

// ─── Click tracking helper ────────────────────────────────────────────────────

function trackClick(deal: SniperDeal, walletAddress: string | null) {
  const destination =
    (deal.source ?? "topshot") === "flowty"
      ? "flowty_listing"
      : "topshot_listing";
  fetch("/api/track-click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      surface: "sniper",
      destination,
      editionKey: deal.editionKey || null,
      momentId: deal.momentId,
      playerName: deal.playerName,
      setName: deal.setName,
      tier: deal.tier,
      serial: deal.serial,
      askPrice: deal.askPrice,
      fmv: deal.adjustedFmv,
      discount: deal.discount,
      walletAddress,
      buyUrl: deal.buyUrl,
    }),
  }).catch(() => {});
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function tierColor(tier: string) {
  switch (tier.toUpperCase()) {
    case "COMMON":    return "text-slate-400";
    case "FANDOM":    return "text-green-400";
    case "RARE":      return "text-blue-400";
    case "LEGENDARY": return "text-yellow-400";
    case "ULTIMATE":  return "text-orange-400";
    default:          return "text-slate-400";
  }
}

function discountColor(pct: number) {
  if (pct >= 50) return "bg-red-500/20 text-red-300 border border-red-500/40";
  if (pct >= 30) return "bg-orange-500/20 text-orange-300 border border-orange-500/40";
  if (pct >= 15) return "bg-yellow-500/20 text-yellow-300 border border-yellow-500/40";
  if (pct >= 5)  return "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40";
  return "bg-slate-700/50 text-slate-400 border border-slate-600/40";
}

function ConfidenceDot({
  confidence,
  source,
  daysSinceSale,
}: {
  confidence: string;
  source?: string;
  daysSinceSale?: number | null;
}) {
  const isFallback = source === "ask_fallback" || !source;
  const isLivetoken = source === "livetoken";
  const level = isFallback
    ? "speculative"
    : confidence === "high"
    ? "verified"
    : confidence === "medium" || isLivetoken
    ? "estimated"
    : "speculative";

  const cfg = {
    verified:    { dot: "bg-emerald-400", label: "Verified",  tip: "FMV backed by real sales data" },
    estimated:   { dot: "bg-yellow-400",  label: "Est.",      tip: "FMV estimated from limited/LiveToken data" },
    speculative: { dot: "bg-red-400/70",  label: "Spec.",     tip: "No sales data — FMV = ask price fallback" },
  }[level];

  const staleLabel =
    daysSinceSale === null || daysSinceSale === undefined ? null
    : daysSinceSale === 0 ? "today"
    : daysSinceSale === 1 ? "1d ago"
    : `${daysSinceSale}d ago`;

  const staleColor =
    daysSinceSale === null || daysSinceSale === undefined ? "text-slate-600"
    : daysSinceSale <= 3 ? "text-emerald-500/70"
    : daysSinceSale <= 14 ? "text-yellow-500/70"
    : "text-red-400/50";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className="inline-flex items-center gap-1 text-xs text-slate-500 cursor-help"
        title={cfg.tip}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        {cfg.label}
      </span>
      {staleLabel && (
        <span className={`text-[10px] ${staleColor}`} title={`Last sale ${staleLabel}`}>
          {staleLabel}
        </span>
      )}
    </div>
  );
}

function SerialBadge({ deal }: { deal: SniperDeal }) {
  if (!deal.isSpecialSerial && deal.serialMult <= 1) return null;
  return (
    <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-xs bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono">
      {deal.serialSignal ?? `×${deal.serialMult.toFixed(1)}`}
    </span>
  );
}

function SourceBadge({ source }: { source?: "topshot" | "flowty" }) {
  if (source === "flowty") {
    return (
      <span className="px-1 py-0.5 rounded text-xs bg-blue-500/15 text-blue-400 border border-blue-500/25 font-mono">
        FLOWTY
      </span>
    );
  }
  return (
    <span className="px-1 py-0.5 rounded text-xs bg-slate-700/60 text-slate-500 border border-slate-600/30 font-mono">
      TS
    </span>
  );
}

function ActionCell({
  deal,
  ownedIds,
  connectedWallet,
}: {
  deal: SniperDeal;
  ownedIds: Set<string>;
  connectedWallet: string | null;
}) {
  const { addToCart, removeFromCart, isInCart } = useCart();
  const inCart = deal.listingResourceID ? isInCart(deal.listingResourceID) : false;
  const isOwned = ownedIds.has(deal.flowId);
  const canCart = !!deal.listingResourceID && !!deal.storefrontAddress;
  const isFlowty = (deal.source ?? "topshot") === "flowty";

  function handleCart() {
    if (!canCart) return;
    if (inCart) {
      removeFromCart(deal.listingResourceID!);
    } else {
      addToCart({
        listingResourceID: deal.listingResourceID!,
        storefrontAddress: deal.storefrontAddress!,
        expectedPrice: deal.askPrice,
        commissionRecipient: COMMISSION_RECIPIENT,
        momentId: Number(deal.momentId),
        playerName: deal.playerName,
        setName: deal.setName,
        serialNumber: deal.serial,
        totalEditions: deal.circulationCount,
        tier: deal.tier,
        thumbnailUrl: deal.thumbnailUrl ?? null,
        fmv: deal.adjustedFmv,
        source: "sniper",
      });
    }
  }

  function handleBuy() {
    trackClick(deal, connectedWallet);
  }

  if (isOwned) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="px-2 py-0.5 rounded text-xs font-semibold bg-slate-700/40 text-slate-500 border border-slate-600/30">
          ✓ Owned
        </span>
        <a
          href={deal.buyUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleBuy}
          className="px-2 py-0.5 rounded text-xs font-bold transition-all bg-slate-700/40 text-slate-500 border border-slate-600/30 hover:text-slate-300"
        >
          VIEW →
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {canCart && (
        <button
          onClick={handleCart}
          className={`px-2 py-0.5 rounded text-xs font-semibold transition-all ${
            inCart
              ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 hover:bg-red-500/20 hover:text-red-300 hover:border-red-500/40"
              : "bg-slate-700/60 text-slate-300 border border-slate-600/50 hover:bg-emerald-500/20 hover:text-emerald-300 hover:border-emerald-500/40"
          }`}
        >
          {inCart ? "✓ In Cart" : "+ Cart"}
        </button>
      )}
      <a
        href={deal.buyUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleBuy}
        className={`px-2 py-0.5 rounded text-xs font-bold transition-all ${
          isFlowty
            ? "bg-blue-600/30 text-blue-300 border border-blue-500/50 hover:bg-blue-600/50"
            : "border text-[#E03A2F] border-[#E03A2F]/40 bg-[#E03A2F]/10 hover:bg-[#E03A2F]/20"
        }`}
      >
        {isFlowty ? "FLOWTY →" : "BUY →"}
      </a>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 30;
const TIER_TABS = ["all", "common", "fandom", "rare", "legendary", "ultimate"] as const;
type TierTab = (typeof TIER_TABS)[number];

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "discount",   label: "Best Discount" },
  { value: "price_asc",  label: "Cheapest First" },
  { value: "price_desc", label: "Most Expensive" },
  { value: "fmv_desc",   label: "Highest FMV" },
  { value: "serial_asc", label: "Lowest Serial" },
];

export default function SniperPage() {
  const [data, setData] = useState<FeedResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [paused, setPaused] = useState(false);

  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [ownedIds, setOwnedIds] = useState<Set<string>>(new Set());

  const [tierTab, setTierTab] = useState<TierTab>("all");
  const [sortBy, setSortBy] = useState<SortOption>("discount");
  const [minDiscount, setMinDiscount] = useState(0);
  const [maxPrice, setMaxPrice] = useState(0);
  const [serialFilter, setSerialFilter] = useState("all");
  const [badgeOnly, setBadgeOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [showVerifiedOnly, setShowVerifiedOnly] = useState(false);

  const countdownRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let cancelled = false;
    import("@onflow/fcl")
      .then((fcl) => {
        fcl.currentUser.subscribe((user: { addr?: string | null }) => {
          if (!cancelled) setConnectedWallet(user?.addr ?? null);
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!connectedWallet) { setOwnedIds(new Set()); return; }
    try {
      const cached = sessionStorage.getItem(`rpc_owned_${connectedWallet}`);
      if (cached) {
        const ids: string[] = JSON.parse(cached);
        setOwnedIds(new Set(ids));
      }
    } catch {}
  }, [connectedWallet]);

  const buildFeedUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (tierTab !== "all") params.set("rarity", tierTab);
    if (minDiscount > 0) params.set("minDiscount", String(minDiscount));
    if (maxPrice > 0) params.set("maxPrice", String(maxPrice));
    if (serialFilter !== "all") params.set("serial", serialFilter);
    if (badgeOnly) params.set("badgeOnly", "true");
    params.set("sortBy", sortBy);
    return `/api/sniper-feed?${params}`;
  }, [tierTab, minDiscount, maxPrice, serialFilter, badgeOnly, sortBy]);

  const fetchFeed = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(buildFeedUrl(), { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: FeedResult = await res.json();
      setData(json);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [buildFeedUrl]);

  useEffect(() => {
    fetchFeed();
    setCountdown(REFRESH_INTERVAL);
  }, [fetchFeed]);

  useEffect(() => {
    if (paused) return;
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { fetchFeed(); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current!);
  }, [paused, fetchFeed]);

  const visibleDeals = (data?.deals ?? []).filter((d) => {
    if (search) {
      const q = search.toLowerCase();
      if (
        !d.playerName.toLowerCase().includes(q) &&
        !d.setName.toLowerCase().includes(q) &&
        !d.teamName.toLowerCase().includes(q)
      ) return false;
    }
    if (showVerifiedOnly && d.confidenceSource === "ask_fallback") return false;
    return true;
  });

  const stats = {
    total: visibleDeals.length,
    hot: visibleDeals.filter((d) => d.discount >= 40).length,
    badge: visibleDeals.filter((d) => d.hasBadge).length,
    special: visibleDeals.filter((d) => d.isSpecialSerial).length,
    avgDiscount:
      visibleDeals.length > 0
        ? visibleDeals.reduce((s, d) => s + d.discount, 0) / visibleDeals.length
        : 0,
    tsLive: (data?.tsCount ?? 0) > 0,
    flowtyLive: (data?.flowtyCount ?? 0) > 0,
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      {/* ── Header ── */}
      <div className="border-b border-slate-800/60 bg-slate-900/40 px-4 py-4">
        <div className="max-w-screen-xl mx-auto">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                <span className="text-2xl">🎯</span> Sniper
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">
                Live deals below adjusted FMV — badge-aware, serial-adjusted
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                  stats.tsLive
                    ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    : "bg-red-500/10 text-red-400/60 border-red-500/20"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${stats.tsLive ? "bg-emerald-400 animate-pulse" : "bg-red-400/50"}`} />
                  TS {stats.tsLive ? `(${data?.tsCount})` : "offline"}
                </span>
                <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
                  stats.flowtyLive
                    ? "bg-blue-500/10 text-blue-400 border-blue-500/30"
                    : "bg-red-500/10 text-red-400/60 border-red-500/20"
                }`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${stats.flowtyLive ? "bg-blue-400 animate-pulse" : "bg-red-400/50"}`} />
                  Flowty {stats.flowtyLive ? `(${data?.flowtyCount})` : "offline"}
                </span>
              </div>
              <button
                onClick={() => setPaused((p) => !p)}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-700 hover:border-slate-600 text-slate-400 hover:text-slate-200 transition-colors"
              >
                {paused ? "▶ Resume" : `⏸ ${countdown}s`}
              </button>
              <button
                onClick={() => { fetchFeed(); setCountdown(REFRESH_INTERVAL); }}
                disabled={loading}
                className="text-xs px-3 py-1.5 rounded-lg border text-[#E03A2F] border-[#E03A2F]/40 bg-[#E03A2F]/10 hover:bg-[#E03A2F]/20 transition-colors disabled:opacity-50"
              >
                {loading ? "↻" : "↻ Refresh"}
              </button>
            </div>
          </div>

          {/* Tier tabs */}
          <div className="flex items-center gap-1 mb-4 flex-wrap">
            {TIER_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTierTab(t)}
                style={
                  tierTab === t
                    ? { backgroundColor: `${ACCENT}22`, color: ACCENT, borderColor: `${ACCENT}80` }
                    : {}
                }
                className={`px-3 py-1 rounded-lg text-xs font-semibold capitalize transition-all border ${
                  tierTab === t
                    ? "border-transparent"
                    : "bg-slate-800/60 text-slate-400 border-slate-700/50 hover:border-slate-600"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search player, set, team…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:border-[#E03A2F]/60 w-52"
            />
            <label className="flex items-center gap-1.5 text-sm text-slate-400 cursor-pointer select-none">
              <span>Min discount</span>
              <input
                type="number"
                min={0} max={100} step={5}
                value={minDiscount}
                onChange={(e) => setMinDiscount(Number(e.target.value))}
                placeholder="0"
                className="w-16 bg-slate-800/60 border border-slate-700/60 rounded-lg px-2 py-1.5 text-sm text-slate-200 focus:outline-none"
              />
              <span>%</span>
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-400 cursor-pointer select-none">
              <span>Max $</span>
              <input
                type="number"
                min={0} step={1}
                value={maxPrice || ""}
                onChange={(e) => setMaxPrice(Number(e.target.value))}
                placeholder="any"
                className="w-20 bg-slate-800/60 border border-slate-700/60 rounded-lg px-2 py-1.5 text-sm text-slate-200 focus:outline-none"
              />
            </label>
            <select
              value={serialFilter}
              onChange={(e) => setSerialFilter(e.target.value)}
              className="bg-slate-800/60 border border-slate-700/60 rounded-lg px-2 py-1.5 text-sm text-slate-300 focus:outline-none"
            >
              <option value="all">All serials</option>
              <option value="special">Special only</option>
              <option value="jersey">Jersey match</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              className="bg-slate-800/60 border border-slate-700/60 rounded-lg px-2 py-1.5 text-sm text-slate-300 focus:outline-none"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={badgeOnly}
                onChange={(e) => setBadgeOnly(e.target.checked)}
                className="rounded border-slate-600 bg-slate-800"
              />
              Badges only
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showVerifiedOnly}
                onChange={(e) => setShowVerifiedOnly(e.target.checked)}
                className="rounded border-slate-600 bg-slate-800"
              />
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                Verified FMV only
              </span>
            </label>
          </div>
        </div>
      </div>

      {/* Stats bar */}
      <div className="border-b border-slate-800/40 bg-slate-900/20 px-4 py-2">
        <div className="max-w-screen-xl mx-auto flex items-center gap-6 text-xs text-slate-500 flex-wrap">
          <span><span className="text-slate-300 font-semibold">{stats.total}</span> deals</span>
          <span><span className="text-red-400 font-semibold">{stats.hot}</span> hot (40%+)</span>
          {stats.badge > 0 && (
            <span><span className="text-yellow-400 font-semibold">{stats.badge}</span> badged</span>
          )}
          {stats.special > 0 && (
            <span><span className="text-purple-400 font-semibold">{stats.special}</span> special serials</span>
          )}
          <span>avg <span className="text-slate-300 font-semibold">{fmt(stats.avgDiscount, 1)}%</span> off</span>
          {connectedWallet && ownedIds.size > 0 && (
            <span className="text-slate-600">{ownedIds.size} owned moments tracked</span>
          )}
          {data?.lastRefreshed && (
            <span className="ml-auto">
              updated {new Date(data.lastRefreshed).toLocaleTimeString([], {
                hour: "2-digit", minute: "2-digit", second: "2-digit",
              })}
            </span>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="max-w-screen-xl mx-auto px-4 py-4">
        {error && (
          <div className="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
            Feed error: {error}
          </div>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-24 text-slate-500 text-sm gap-2">
            <span className="animate-spin">↻</span> Loading deals…
          </div>
        )}

        {!loading && visibleDeals.length === 0 && data && (
          <div className="flex flex-col items-center justify-center py-24 text-slate-500 gap-3">
            <span className="text-3xl opacity-40">🎯</span>
            <p className="text-sm">No deals match your filters right now.</p>
            <button
              onClick={() => {
                setTierTab("all"); setMinDiscount(0); setMaxPrice(0);
                setSerialFilter("all"); setBadgeOnly(false);
                setShowVerifiedOnly(false); setSearch("");
              }}
              className="text-xs hover:underline"
              style={{ color: ACCENT }}
            >
              Clear filters
            </button>
          </div>
        )}

        {visibleDeals.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-slate-800/60">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800/60 bg-slate-900/60">
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider w-10" />
                  <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Moment</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Serial</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Ask</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Adj. FMV</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Discount</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">FMV Quality</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Src</th>
                  <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/40">
                {visibleDeals.map((deal) => (
                  <tr
                    key={`${deal.source}-${deal.flowId}-${deal.listingResourceID}`}
                    className={`hover:bg-slate-800/30 transition-colors ${deal.discount >= 40 ? "bg-red-950/10" : ""}`}
                  >
                    {/* Thumbnail */}
                    <td className="px-3 py-2">
                      {deal.thumbnailUrl ? (
                        <img
                          src={deal.thumbnailUrl}
                          alt={deal.playerName}
                          className="w-8 h-8 rounded object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded bg-slate-800" />
                      )}
                    </td>

                    {/* Moment info */}
                    <td className="px-3 py-2">
                      <div className="font-semibold text-slate-200 leading-tight">{deal.playerName}</div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className={`text-xs font-medium ${tierColor(deal.tier)}`}>
                          {deal.tier.charAt(0) + deal.tier.slice(1).toLowerCase()}
                        </span>
                        {deal.parallel !== "Base" && (
                          <span className="text-xs text-slate-500">{deal.parallel}</span>
                        )}
                        <span className="text-xs text-slate-600">·</span>
                        <span className="text-xs text-slate-500">{deal.setName}</span>
                        {deal.seriesName && (
                          <>
                            <span className="text-xs text-slate-600">·</span>
                            <span className="text-xs text-slate-600">{deal.seriesName}</span>
                          </>
                        )}
                        {deal.teamName && (
                          <>
                            <span className="text-xs text-slate-600">·</span>
                            <span className="text-xs text-slate-600">{deal.teamName}</span>
                          </>
                        )}
                      </div>
                      {deal.hasBadge && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {deal.badgeLabels.map((label) => (
                            <span
                              key={label}
                              className="px-1 py-0.5 rounded text-xs bg-yellow-500/15 text-yellow-400 border border-yellow-500/25"
                            >
                              {label}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Serial */}
                    <td className="px-3 py-2 text-right">
                      <div className="font-mono text-slate-300 text-sm">#{deal.serial}</div>
                      {deal.circulationCount > 0 && (
                        <div className="text-xs text-slate-600">/ {deal.circulationCount.toLocaleString()}</div>
                      )}
                      {deal.isSpecialSerial && <SerialBadge deal={deal} />}
                    </td>

                    {/* Ask */}
                    <td className="px-3 py-2 text-right font-mono text-slate-200">
                      ${fmt(deal.askPrice)}
                    </td>

                    {/* Adjusted FMV */}
                    <td className="px-3 py-2 text-right">
                      <div className="font-mono text-slate-300 flex items-center justify-end gap-1">
                        ${fmt(deal.adjustedFmv)}
                        {deal.wapUsd !== null && deal.wapUsd > 0 && (() => {
                          const diff = (deal.wapUsd - deal.baseFmv) / deal.baseFmv;
                          if (Math.abs(diff) < 0.1) return null;
                          return diff > 0
                            ? <span className="text-xs text-emerald-400" title={`WAP $${fmt(deal.wapUsd)} — trending up`}>↑</span>
                            : <span className="text-xs text-red-400/70" title={`WAP $${fmt(deal.wapUsd)} — trending down`}>↓</span>;
                        })()}
                      </div>
                      {deal.serialMult > 1 && (
                        <div className="text-xs text-slate-600">
                          base ${fmt(deal.baseFmv)} × {deal.serialMult.toFixed(2)}
                        </div>
                      )}
                    </td>

                    {/* Discount */}
                    <td className="px-3 py-2 text-right">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${discountColor(deal.discount)}`}>
                        {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                      </span>
                    </td>

                    {/* Confidence + staleness */}
                    <td className="px-3 py-2 text-right">
                      <ConfidenceDot
                        confidence={deal.confidence}
                        source={deal.confidenceSource}
                        daysSinceSale={deal.daysSinceSale}
                      />
                    </td>

                    {/* Source */}
                    <td className="px-3 py-2 text-right">
                      <SourceBadge source={deal.source} />
                    </td>

                    {/* Action */}
                    <td className="px-3 py-2">
                      <ActionCell
                        deal={deal}
                        ownedIds={ownedIds}
                        connectedWallet={connectedWallet}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="mt-4 flex items-center gap-4 text-xs text-slate-600 flex-wrap">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
            Verified — backed by real sales
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block" />
            Estimated — limited / LiveToken data
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-red-400/70 inline-block" />
            Speculative — FMV = ask price fallback
          </span>
          <span className="flex items-center gap-1 text-emerald-500/50">↑</span>
          <span>WAP trending up &nbsp;</span>
          <span className="flex items-center gap-1 text-red-400/50">↓</span>
          <span>WAP trending down</span>
          <span className="ml-auto">Adj. FMV = base FMV × serial multiplier</span>
        </div>
      </div>
    </div>
  );
}