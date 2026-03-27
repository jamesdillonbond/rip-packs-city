"use client";

import { useEffect, useState, useCallback, useRef } from "react";

// ─── Types ────────────────────────────────────────────────────────────────────
interface SniperDeal {
  flowId: string;
  momentId: string;
  playerName: string;
  teamName: string;
  setName: string;
  seriesName: string;
  tier: string;
  parallel: string;
  serial: number;
  circulationCount: number;
  askPrice: number;
  baseFmv: number;
  adjustedFmv: number;
  discount: number;
  confidence: string;
  hasBadge: boolean;
  badgeSlugs: string[];
  badgeLabels: string[];
  badgePremiumPct: number;
  serialMult: number;
  isSpecialSerial: boolean;
  isJersey: boolean;
  serialSignal: string | null;
  packListingId: string | null;
  packName: string | null;
  packEv: number | null;
  packEvRatio: number | null;
  buyUrl: string;
}

interface FeedResponse {
  count: number;
  lastRefreshed: string;
  deals: SniperDeal[];
}

// ─── Constants ────────────────────────────────────────────────────────────────
const RARITY_COLORS: Record<string, string> = {
  COMMON: "text-zinc-400",
  RARE: "text-blue-400",
  LEGENDARY: "text-yellow-400",
  ULTIMATE: "text-purple-400",
};

const RARITY_BORDER: Record<string, string> = {
  COMMON: "border-zinc-700",
  RARE: "border-blue-800",
  LEGENDARY: "border-yellow-800",
  ULTIMATE: "border-purple-800",
};

const CONFIDENCE_COLORS: Record<string, string> = {
  high: "text-green-400",
  medium: "text-yellow-400",
  low: "text-zinc-500",
  very_low: "text-zinc-600",
};

const REFRESH_INTERVAL = 30_000; // 30 seconds

// ─── Helpers ──────────────────────────────────────────────────────────────────
function discountColor(discount: number): string {
  if (discount >= 40) return "text-green-400 font-bold";
  if (discount >= 20) return "text-green-500";
  if (discount >= 5) return "text-zinc-300";
  if (discount >= -5) return "text-zinc-500";
  return "text-red-500";
}

function discountBadge(discount: number): { label: string; cls: string } | null {
  if (discount >= 50) return { label: "🔥 50%+ OFF", cls: "bg-green-900 text-green-300 border border-green-700" };
  if (discount >= 40) return { label: "🟢 40%+ OFF", cls: "bg-green-950 text-green-400 border border-green-800" };
  if (discount >= 25) return { label: "⬇ 25%+ OFF", cls: "bg-zinc-800 text-green-500 border border-zinc-700" };
  return null;
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function SniperPage() {
  const [deals, setDeals] = useState<SniperDeal[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [minDiscount, setMinDiscount] = useState(10);
  const [rarity, setRarity] = useState("all");
  const [badgeOnly, setBadgeOnly] = useState(false);
  const [serialFilter, setSerialFilter] = useState("all");
  const [maxPrice, setMaxPrice] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchDeals = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        minDiscount: String(minDiscount),
        rarity,
        badgeOnly: String(badgeOnly),
        serial: serialFilter,
        maxPrice: String(maxPrice),
      });
      const res = await fetch(`/api/sniper-feed?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FeedResponse = await res.json();
      setDeals(data.deals);
      setLastRefreshed(data.lastRefreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [minDiscount, rarity, badgeOnly, serialFilter, maxPrice]);

  // Initial fetch
  useEffect(() => {
    fetchDeals();
  }, [fetchDeals]);

  // Auto-refresh timer
  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }

    setCountdown(REFRESH_INTERVAL / 1000);

    timerRef.current = setInterval(() => {
      fetchDeals();
      setCountdown(REFRESH_INTERVAL / 1000);
    }, REFRESH_INTERVAL);

    countdownRef.current = setInterval(() => {
      setCountdown((c) => Math.max(0, c - 1));
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, fetchDeals]);

  // Client-side text search
  const visible = deals.filter((d) => {
    if (!searchText) return true;
    const q = searchText.toLowerCase();
    return (
      d.playerName.toLowerCase().includes(q) ||
      d.setName.toLowerCase().includes(q) ||
      d.teamName.toLowerCase().includes(q) ||
      d.parallel.toLowerCase().includes(q)
    );
  });

  const stats = {
    total: visible.length,
    badgeDeals: visible.filter((d) => d.hasBadge).length,
    serialDeals: visible.filter((d) => d.isSpecialSerial).length,
    avgDiscount:
      visible.length > 0
        ? Math.round(visible.reduce((s, d) => s + d.discount, 0) / visible.length)
        : 0,
    hot: visible.filter((d) => d.discount >= 40).length,
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1700px] px-3 py-4 md:px-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img
            src="/rip-packs-city-logo.png"
            alt="Rip Packs City"
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "9999px" }}
          />
          <div>
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">
              RIP PACKS CITY
            </h1>
            <p className="text-xs text-zinc-400 md:text-sm">Wallet intelligence for digital collectibles</p>
          </div>
          <div className="ml-auto flex gap-2">
            <a href="/wallet" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Wallet</a>
            <a href="/packs" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Packs</a>
            <a href="/badges" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Badges</a>
            <a href="/sniper" className="rounded-lg border border-red-600 bg-red-600/10 px-3 py-1.5 text-sm text-red-400 font-semibold">🎯 Sniper</a>
          </div>
        </div>

        {/* ── Page Title + Refresh ────────────────────────────────────────── */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">
              🎯 Sniper
            </h2>
            <p className="text-sm text-zinc-500 mt-0.5">
              Live listings below FMV — badge-adjusted &amp; serial-premium aware
            </p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefreshed && (
              <span className="text-xs text-zinc-600">
                Updated {new Date(lastRefreshed).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={() => setAutoRefresh((v) => !v)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
                autoRefresh
                  ? "border-green-700 bg-green-950 text-green-400"
                  : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"
              }`}
            >
              {autoRefresh ? `⏱ Auto ${countdown}s` : "⏸ Paused"}
            </button>
            <button
              onClick={fetchDeals}
              disabled={loading}
              className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50"
            >
              {loading ? "Loading…" : "↺ Refresh"}
            </button>
          </div>
        </div>

        {/* ── Stats Bar ───────────────────────────────────────────────────── */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Deals Found", value: stats.total },
            { label: "🔥 Hot (40%+ off)", value: stats.hot, highlight: stats.hot > 0 },
            { label: "🏅 Badge Deals", value: stats.badgeDeals },
            { label: "🔢 Special Serials", value: stats.serialDeals },
            { label: "Avg Discount", value: `${stats.avgDiscount}%` },
          ].map((s) => (
            <div
              key={s.label}
              className={`rounded-xl border p-3 ${
                s.highlight
                  ? "border-green-800 bg-green-950/30"
                  : "border-zinc-800 bg-zinc-950"
              }`}
            >
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{s.label}</div>
              <div className={`text-lg font-bold ${s.highlight ? "text-green-400" : "text-white"}`}>
                {s.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── Filters ─────────────────────────────────────────────────────── */}
        <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Filters</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">

            {/* Min Discount */}
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Min Discount %
              </label>
              <select
                value={minDiscount}
                onChange={(e) => setMinDiscount(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
              >
                <option value={0}>Any</option>
                <option value={5}>5%+</option>
                <option value={10}>10%+</option>
                <option value={20}>20%+</option>
                <option value={30}>30%+</option>
                <option value={40}>40%+ 🔥</option>
              </select>
            </div>

            {/* Rarity */}
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Rarity
              </label>
              <select
                value={rarity}
                onChange={(e) => setRarity(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
              >
                <option value="all">All Rarities</option>
                <option value="common">Common</option>
                <option value="rare">Rare</option>
                <option value="legendary">Legendary</option>
                <option value="ultimate">Ultimate</option>
              </select>
            </div>

            {/* Max Price */}
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Max Price
              </label>
              <select
                value={maxPrice}
                onChange={(e) => setMaxPrice(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
              >
                <option value={0}>Any Price</option>
                <option value={5}>Under $5</option>
                <option value={25}>Under $25</option>
                <option value={50}>Under $50</option>
                <option value={100}>Under $100</option>
                <option value={250}>Under $250</option>
              </select>
            </div>

            {/* Serial Filter */}
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Serial Type
              </label>
              <select
                value={serialFilter}
                onChange={(e) => setSerialFilter(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white"
              >
                <option value="all">All Serials</option>
                <option value="special">Special Only (#1, Last, Low)</option>
                <option value="jersey">Jersey Numbers Only</option>
              </select>
            </div>

            {/* Badge Filter */}
            <div className="flex flex-col justify-between">
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Badge Moments
              </label>
              <button
                onClick={() => setBadgeOnly((v) => !v)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                  badgeOnly
                    ? "border-yellow-600 bg-yellow-950/40 text-yellow-400"
                    : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"
                }`}
              >
                {badgeOnly ? "🏅 Badge Only" : "All Moments"}
              </button>
            </div>

            {/* Search */}
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Search
              </label>
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder="Player, set, team…"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-red-600"
              />
            </div>
          </div>
        </div>

        {/* ── Error ───────────────────────────────────────────────────────── */}
        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
            ⚠ Error loading feed: {error}
          </div>
        )}

        {/* ── Table ───────────────────────────────────────────────────────── */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
          <table className="w-full min-w-[1200px] border-collapse text-sm">
            <thead className="bg-zinc-900">
              <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="p-3 w-6"></th>
                <th className="p-3">Player</th>
                <th className="p-3">Set / Parallel</th>
                <th className="p-3">Rarity</th>
                <th className="p-3">Serial</th>
                <th className="p-3">Ask</th>
                <th className="p-3">Adj. FMV</th>
                <th className="p-3">Discount</th>
                <th className="p-3">Signals</th>
                <th className="p-3">Pack</th>
                <th className="p-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-16 text-center text-zinc-600">
                    <div className="flex flex-col items-center gap-2">
                      <div className="h-6 w-6 animate-spin rounded-full border-2 border-red-600 border-t-transparent" />
                      <span>Scanning live listings…</span>
                    </div>
                  </td>
                </tr>
              )}
              {!loading && visible.length === 0 && (
                <tr>
                  <td colSpan={11} className="py-16 text-center text-zinc-600">
                    No deals found matching your filters. Try lowering the discount threshold.
                  </td>
                </tr>
              )}
              {visible.map((deal, i) => {
                const badge = discountBadge(deal.discount);
                const tierColor = RARITY_COLORS[deal.tier] ?? "text-zinc-400";
                const tierBorder = RARITY_BORDER[deal.tier] ?? "border-zinc-800";

                return (
                  <tr
                    key={deal.momentId}
                    className={`border-b border-zinc-800/60 hover:bg-zinc-900/50 transition ${
                      deal.discount >= 40 ? "bg-green-950/10" : ""
                    }`}
                  >
                    {/* Row rank */}
                    <td className="px-3 py-2 text-xs text-zinc-600 text-right">{i + 1}</td>

                    {/* Player */}
                    <td className="px-3 py-3">
                      <div className="font-semibold text-white leading-tight">{deal.playerName}</div>
                      {deal.teamName && (
                        <div className="text-[11px] text-zinc-500 mt-0.5">{deal.teamName}</div>
                      )}
                    </td>

                    {/* Set / Parallel */}
                    <td className="px-3 py-3">
                      <div className="text-zinc-300 leading-tight text-xs">{deal.setName}</div>
                      {deal.parallel !== "Base" && (
                        <div className="mt-0.5 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-800 text-zinc-300">
                          {deal.parallel}
                        </div>
                      )}
                    </td>

                    {/* Rarity */}
                    <td className="px-3 py-3">
                      <span className={`text-xs font-semibold ${tierColor}`}>
                        {deal.tier.charAt(0) + deal.tier.slice(1).toLowerCase()}
                      </span>
                    </td>

                    {/* Serial */}
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span
                          className={`text-sm font-mono ${
                            deal.isSpecialSerial ? "text-yellow-400 font-bold" : "text-zinc-300"
                          }`}
                        >
                          #{deal.serial}
                        </span>
                        <span className="text-[10px] text-zinc-600">/{deal.circulationCount}</span>
                        {deal.serialSignal && (
                          <span className="text-[10px] text-yellow-500">{deal.serialSignal}</span>
                        )}
                      </div>
                    </td>

                    {/* Ask */}
                    <td className="px-3 py-3">
                      <span className="text-white font-semibold">{fmt(deal.askPrice)}</span>
                    </td>

                    {/* Adj FMV */}
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-0.5">
                        <span className="text-zinc-300">{fmt(deal.adjustedFmv)}</span>
                        {deal.adjustedFmv !== deal.baseFmv && (
                          <span className="text-[10px] text-zinc-600">
                            base {fmt(deal.baseFmv)}
                          </span>
                        )}
                        <span className={`text-[10px] ${CONFIDENCE_COLORS[deal.confidence] ?? "text-zinc-600"}`}>
                          {deal.confidence} conf
                        </span>
                      </div>
                    </td>

                    {/* Discount */}
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={`text-base font-bold ${discountColor(deal.discount)}`}>
                          {deal.discount > 0 ? "−" : "+"}{Math.abs(deal.discount)}%
                        </span>
                        {badge && (
                          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                            {badge.label}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Signals */}
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        {deal.badgeLabels.map((label) => (
                          <span
                            key={label}
                            className="rounded bg-yellow-900/40 border border-yellow-700/50 px-1.5 py-0.5 text-[10px] text-yellow-400 font-medium"
                          >
                            🏅 {label}
                            {deal.badgePremiumPct > 0 && (
                              <span className="ml-1 text-yellow-600">+{deal.badgePremiumPct}%</span>
                            )}
                          </span>
                        ))}
                        {deal.serialMult > 1.1 && (
                          <span className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                            🔢 {deal.serialMult}× serial
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Pack */}
                    <td className="px-3 py-3">
                      {deal.packName ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-[11px] text-zinc-400 leading-tight">{deal.packName}</span>
                          {deal.packEv !== null && (
                            <span
                              className={`text-[10px] font-medium ${
                                (deal.packEvRatio ?? 0) >= 1.2
                                  ? "text-green-400"
                                  : (deal.packEvRatio ?? 0) >= 1.0
                                  ? "text-yellow-400"
                                  : "text-zinc-500"
                              }`}
                            >
                              EV {fmt(deal.packEv)}
                              {deal.packEvRatio !== null && ` (${(deal.packEvRatio * 100).toFixed(0)}%)`}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-zinc-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Action */}
                    <td className="px-3 py-3">
                      <a
                        href={deal.buyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500 active:scale-95"
                      >
                        BUY →
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* ── Footer ─────────────────────────────────────────────────────── */}
        <div className="mt-4 text-center text-xs text-zinc-700">
          FMV is adjusted for badge premiums and serial multipliers. Discount = (Adjusted FMV − Ask) / Adjusted FMV.
          Auto-refreshes every 30s. Data sourced from NBA Top Shot marketplace.
        </div>
      </div>
    </div>
  );
}