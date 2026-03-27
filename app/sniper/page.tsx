"use client";

import { useEffect, useState, useCallback, useRef } from "react";

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
  thumbnailUrl: string | null;
  isLocked: boolean;
  updatedAt: string | null;
  isStale: boolean;
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

// Wallet search response shape (subset we need)
interface WalletMoment {
  setId?: string;
  playId?: string;
  isLocked?: boolean;
  parallelId?: number;
  editionKey?: string;
}

const TIER_COLOR: Record<string, string> = {
  COMMON: "text-zinc-400", RARE: "text-blue-400",
  LEGENDARY: "text-yellow-400", ULTIMATE: "text-purple-400",
};
const CONFIDENCE_COLOR: Record<string, string> = {
  high: "text-green-400", medium: "text-yellow-400",
  live: "text-cyan-400", "live-avg": "text-cyan-600",
  low: "text-zinc-500", very_low: "text-zinc-600",
};
const REFRESH_INTERVAL = 30_000;

function discountColor(d: number) {
  if (d >= 40) return "text-green-400 font-bold";
  if (d >= 20) return "text-green-500";
  if (d >= 5) return "text-zinc-300";
  if (d >= -5) return "text-zinc-500";
  return "text-red-500";
}

function discountBadge(d: number): { label: string; cls: string } | null {
  if (d >= 50) return { label: "🔥 50%+ OFF", cls: "bg-green-900 text-green-300 border border-green-700" };
  if (d >= 40) return { label: "🔥 40%+ OFF", cls: "bg-green-950 text-green-400 border border-green-800" };
  if (d >= 25) return { label: "⬇ 25%+ OFF", cls: "bg-zinc-800 text-green-500 border border-zinc-700" };
  return null;
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function listingAge(updatedAt: string | null): string {
  if (!updatedAt) return "";
  const ms = Date.now() - new Date(updatedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

export default function SniperPage() {
  const [deals, setDeals] = useState<SniperDeal[]>([]);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Wallet state
  const [walletInput, setWalletInput] = useState("");
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  // editionKey set for owned moments, value = true if locked
  const [ownedEditions, setOwnedEditions] = useState<Map<string, boolean>>(new Map());

  // Filters
  const [minDiscount, setMinDiscount] = useState(10);
  const [rarity, setRarity] = useState("all");
  const [badgeOnly, setBadgeOnly] = useState(false);
  const [serialFilter, setSerialFilter] = useState("all");
  const [maxPrice, setMaxPrice] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [ownedFilter, setOwnedFilter] = useState("all"); // all | owned | not_owned
  const [hideInactive, setHideInactive] = useState(false);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevIdsRef = useRef<Set<string>>(new Set());

  const fetchDeals = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({
        minDiscount: String(minDiscount), rarity,
        badgeOnly: String(badgeOnly), serial: serialFilter, maxPrice: String(maxPrice),
      });
      const res = await fetch(`/api/sniper-feed?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: FeedResponse = await res.json();

      const incoming = new Set(data.deals.map(d => d.momentId));
      const isNew = new Set<string>();
      for (const id of incoming) {
        if (prevIdsRef.current.size > 0 && !prevIdsRef.current.has(id)) isNew.add(id);
      }
      prevIdsRef.current = incoming;
      setNewIds(isNew);
      if (isNew.size > 0) setTimeout(() => setNewIds(new Set()), 3000);

      setDeals(data.deals);
      setLastRefreshed(data.lastRefreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [minDiscount, rarity, badgeOnly, serialFilter, maxPrice]);

  useEffect(() => { fetchDeals(); }, [fetchDeals]);

  useEffect(() => {
    if (!autoRefresh) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
      return;
    }
    setCountdown(REFRESH_INTERVAL / 1000);
    timerRef.current = setInterval(() => { fetchDeals(); setCountdown(REFRESH_INTERVAL / 1000); }, REFRESH_INTERVAL);
    countdownRef.current = setInterval(() => setCountdown(c => Math.max(0, c - 1)), 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoRefresh, fetchDeals]);

  // Load wallet owned moments
  const loadWallet = useCallback(async () => {
    const w = walletInput.trim();
    if (!w) return;
    setWalletLoading(true);
    setWalletError(null);
    try {
      const res = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: w }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Build editionKey → isLocked map from wallet moments
      // wallet-search returns moments with setId, playId, isLocked fields
      const map = new Map<string, boolean>();
      const moments: WalletMoment[] = data.moments ?? data ?? [];
      for (const m of moments) {
        const key = m.editionKey ?? (m.setId && m.playId ? `${m.setId}:${m.playId}` : null);
        if (key) map.set(key, m.isLocked ?? false);
      }
      setOwnedEditions(map);
      setLoadedWallet(w);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Failed to load wallet");
    } finally {
      setWalletLoading(false);
    }
  }, [walletInput]);

  const clearWallet = () => {
    setOwnedEditions(new Map());
    setLoadedWallet(null);
    setWalletInput("");
    setOwnedFilter("all");
  };

  // Client-side filtering
  const visible = deals.filter(d => {
    if (hideInactive && d.isStale) return false;
    if (ownedFilter === "owned" && !ownedEditions.has(d.editionKey)) return false;
    if (ownedFilter === "not_owned" && ownedEditions.has(d.editionKey)) return false;
    if (!searchText) return true;
    const q = searchText.toLowerCase();
    return d.playerName.toLowerCase().includes(q)
      || d.setName.toLowerCase().includes(q)
      || d.teamName.toLowerCase().includes(q)
      || d.parallel.toLowerCase().includes(q);
  });

  const stats = {
    total: visible.length,
    hot: visible.filter(d => d.discount >= 40).length,
    badge: visible.filter(d => d.hasBadge).length,
    serial: visible.filter(d => d.isSpecialSerial).length,
    avgDiscount: visible.length > 0
      ? Math.round(visible.reduce((s, d) => s + d.discount, 0) / visible.length) : 0,
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1700px] px-3 py-4 md:px-6">

        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img src="/rip-packs-city-logo.png" alt="Rip Packs City"
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "9999px" }} />
          <div>
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">RIP PACKS CITY</h1>
            <p className="text-xs text-zinc-400 md:text-sm">Wallet intelligence for digital collectibles</p>
          </div>
          <div className="ml-auto flex gap-2">
            <a href="/wallet" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Wallet</a>
            <a href="/packs" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Packs</a>
            <a href="/badges" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Badges</a>
            <a href="/sniper" className="rounded-lg border border-red-600 bg-red-600/10 px-3 py-1.5 text-sm text-red-400 font-semibold">🎯 Sniper</a>
          </div>
        </div>

        {/* Title + controls */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">🎯 Sniper</h2>
            <p className="text-sm text-zinc-500 mt-0.5">Live listings below FMV — badge-adjusted &amp; serial-premium aware</p>
          </div>
          <div className="flex items-center gap-3">
            {lastRefreshed && (
              <span className="text-xs text-zinc-600">Updated {new Date(lastRefreshed).toLocaleTimeString()}</span>
            )}
            <button onClick={() => setAutoRefresh(v => !v)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${autoRefresh ? "border-green-700 bg-green-950 text-green-400" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"}`}>
              {autoRefresh ? `⏱ Auto ${countdown}s` : "⏸ Paused"}
            </button>
            <button onClick={fetchDeals} disabled={loading}
              className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white transition hover:bg-red-500 disabled:opacity-50">
              {loading ? "Loading…" : "↺ Refresh"}
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Deals Found", value: stats.total },
            { label: "🔥 Hot (40%+ off)", value: stats.hot, hot: stats.hot > 0 },
            { label: "🏅 Badge Deals", value: stats.badge },
            { label: "🔢 Special Serials", value: stats.serial },
            { label: "Avg Discount", value: `${stats.avgDiscount}%` },
          ].map(s => (
            <div key={s.label} className={`rounded-xl border p-3 ${s.hot ? "border-green-800 bg-green-950/30" : "border-zinc-800 bg-zinc-950"}`}>
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">{s.label}</div>
              <div className={`text-lg font-bold ${s.hot ? "text-green-400" : "text-white"}`}>{s.value}</div>
            </div>
          ))}
        </div>

        {/* Filters */}
        <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">Filters</div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4 mb-3">
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Min Discount %</label>
              <select value={minDiscount} onChange={e => setMinDiscount(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white">
                <option value={0}>Any</option><option value={5}>5%+</option><option value={10}>10%+</option>
                <option value={20}>20%+</option><option value={30}>30%+</option><option value={40}>40%+ 🔥</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Rarity</label>
              <select value={rarity} onChange={e => setRarity(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white">
                <option value="all">All Rarities</option><option value="common">Common</option>
                <option value="rare">Rare</option><option value="legendary">Legendary</option>
                <option value="ultimate">Ultimate</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Max Price</label>
              <select value={maxPrice} onChange={e => setMaxPrice(Number(e.target.value))}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white">
                <option value={0}>Any Price</option><option value={5}>Under $5</option>
                <option value={25}>Under $25</option><option value={50}>Under $50</option>
                <option value={100}>Under $100</option><option value={250}>Under $250</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Serial Type</label>
              <select value={serialFilter} onChange={e => setSerialFilter(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white">
                <option value="all">All Serials</option>
                <option value="special">Special Only (#1, Last, Low)</option>
                <option value="jersey">Jersey Numbers Only</option>
              </select>
            </div>
            <div className="flex flex-col justify-between">
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Badge Moments</label>
              <button onClick={() => setBadgeOnly(v => !v)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${badgeOnly ? "border-yellow-600 bg-yellow-950/40 text-yellow-400" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"}`}>
                {badgeOnly ? "🏅 Badge Only" : "All Moments"}
              </button>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">
                Ownership {loadedWallet && <span className="text-zinc-600 normal-case font-normal">({ownedEditions.size} editions)</span>}
              </label>
              <select value={ownedFilter} onChange={e => setOwnedFilter(e.target.value)}
                disabled={!loadedWallet}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40">
                <option value="all">All</option>
                <option value="owned">Owned Only</option>
                <option value="not_owned">Not Owned</option>
              </select>
            </div>
            <div className="flex flex-col justify-between">
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Inactive Listings</label>
              <button onClick={() => setHideInactive(v => !v)}
                className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${hideInactive ? "border-red-700 bg-red-950/40 text-red-400" : "border-zinc-700 text-zinc-400 hover:bg-zinc-900"}`}>
                {hideInactive ? "Hiding Stale" : "Show All"}
              </button>
            </div>
            <div>
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Search</label>
              <input value={searchText} onChange={e => setSearchText(e.target.value)}
                placeholder="Player, set, team…"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-red-600" />
            </div>
          </div>

          {/* Wallet section */}
          <div className="border-t border-zinc-800 pt-3">
            <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-zinc-500">
              Wallet — load to see owned/locked status
            </label>
            {loadedWallet ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-green-400">✓ {loadedWallet}</span>
                <span className="text-xs text-zinc-600">{ownedEditions.size} editions tracked</span>
                <button onClick={clearWallet}
                  className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-900">
                  Clear
                </button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input
                  value={walletInput}
                  onChange={e => setWalletInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && loadWallet()}
                  placeholder="Top Shot username or wallet address"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-red-600 max-w-sm"
                />
                <button onClick={loadWallet} disabled={walletLoading || !walletInput.trim()}
                  className="rounded-lg bg-zinc-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-600 disabled:opacity-50">
                  {walletLoading ? "Loading…" : "Load"}
                </button>
              </div>
            )}
            {walletError && <p className="mt-1 text-xs text-red-400">{walletError}</p>}
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
            ⚠ Error: {error}
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
          <table className="w-full min-w-[1200px] border-collapse text-sm">
            <thead className="bg-zinc-900">
              <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                <th className="p-3 w-5">#</th>
                <th className="p-3 w-14"></th>
                <th className="p-3">Player</th>
                <th className="p-3">Set</th>
                <th className="p-3">Rarity</th>
                <th className="p-3">Serial</th>
                <th className="p-3">Ask</th>
                <th className="p-3">Adj. FMV</th>
                <th className="p-3">Discount</th>
                <th className="p-3">Owned</th>
                <th className="p-3">Signals</th>
                <th className="p-3">Listed</th>
                <th className="p-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading && visible.length === 0 && (
                <tr><td colSpan={13} className="py-16 text-center text-zinc-600">
                  <div className="flex flex-col items-center gap-2">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-red-600 border-t-transparent" />
                    <span>Scanning live listings…</span>
                  </div>
                </td></tr>
              )}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={13} className="py-16 text-center text-zinc-600">
                  No deals found. Try lowering the discount threshold.
                </td></tr>
              )}
              {visible.map((deal, i) => {
                const badge = discountBadge(deal.discount);
                const isNew = newIds.has(deal.momentId);
                const tierColor = TIER_COLOR[deal.tier] ?? "text-zinc-400";
                const isOwned = ownedEditions.has(deal.editionKey);
                const isOwnedLocked = isOwned && ownedEditions.get(deal.editionKey) === true;
                const listingLocked = deal.isLocked;

                return (
                  <tr key={deal.momentId}
                    className={`border-b border-zinc-800/60 transition-all duration-500 hover:bg-zinc-900/50
                      ${deal.discount >= 40 ? "bg-green-950/10" : ""}
                      ${isNew ? "animate-pulse bg-yellow-950/20" : ""}
                      ${deal.isStale ? "opacity-50" : ""}`}>

                    <td className="px-3 py-2 text-xs text-zinc-600">{i + 1}</td>

                    {/* Thumbnail */}
                    <td className="px-2 py-2">
                      {deal.thumbnailUrl ? (
                        <a href={deal.buyUrl} target="_blank" rel="noopener noreferrer">
                          <img src={deal.thumbnailUrl} alt={deal.playerName}
                            className="w-12 h-12 rounded-lg object-cover border border-zinc-700 hover:border-zinc-500 transition"
                            onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        </a>
                      ) : (
                        <div className="w-12 h-12 rounded-lg bg-zinc-800 border border-zinc-700" />
                      )}
                    </td>

                    {/* Player */}
                    <td className="px-3 py-3">
                      <div className="font-semibold text-white leading-tight">{deal.playerName}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5 flex gap-1.5">
                        {deal.teamName && <span>{deal.teamName}</span>}
                        {deal.seriesName && <span className="text-zinc-600">· {deal.seriesName}</span>}
                      </div>
                    </td>

                    {/* Set */}
                    <td className="px-3 py-3">
                      <div className="text-zinc-300 text-xs leading-tight">{deal.setName}</div>
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
                      <div className={`text-sm font-mono ${deal.isSpecialSerial ? "text-yellow-400 font-bold" : "text-zinc-300"}`}>
                        #{deal.serial}
                      </div>
                      <div className="text-[10px] text-zinc-600">/{deal.circulationCount.toLocaleString()}</div>
                      {deal.serialSignal && (
                        <div className="text-[10px] text-yellow-500 mt-0.5">{deal.serialSignal}</div>
                      )}
                    </td>

                    {/* Ask */}
                    <td className="px-3 py-3">
                      <span className="text-white font-semibold">{fmt(deal.askPrice)}</span>
                    </td>

                    {/* Adj FMV */}
                    <td className="px-3 py-3">
                      <div className="text-zinc-300">{fmt(deal.adjustedFmv)}</div>
                      {deal.adjustedFmv !== deal.baseFmv && (
                        <div className="text-[10px] text-zinc-600">base {fmt(deal.baseFmv)}</div>
                      )}
                      <div className={`text-[10px] ${CONFIDENCE_COLOR[deal.confidence] ?? "text-zinc-600"}`}>
                        {deal.confidence}
                      </div>
                    </td>

                    {/* Discount */}
                    <td className="px-3 py-3">
                      <div className={`text-base font-bold ${discountColor(deal.discount)}`}>
                        {deal.discount > 0 ? "−" : "+"}{Math.abs(deal.discount)}%
                      </div>
                      {badge && (
                        <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                          {badge.label}
                        </span>
                      )}
                    </td>

                    {/* Owned column */}
                    <td className="px-3 py-3">
                      {isOwned ? (
                        <div className="flex flex-col gap-0.5">
                          {isOwnedLocked ? (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-orange-950/50 border border-orange-800 text-orange-400">
                              🔒 Locked
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-green-950/50 border border-green-800 text-green-400">
                              ✓ Owned
                            </span>
                          )}
                        </div>
                      ) : listingLocked ? (
                        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-800 border border-zinc-700 text-zinc-500">
                          🔒 Listing Locked
                        </span>
                      ) : (
                        <span className="text-zinc-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Signals */}
                    <td className="px-3 py-3">
                      <div className="flex flex-col gap-1">
                        {deal.badgeLabels.map(label => (
                          <span key={label} className="rounded bg-yellow-900/40 border border-yellow-700/50 px-1.5 py-0.5 text-[10px] text-yellow-400 font-medium">
                            🏅 {label}{deal.badgePremiumPct > 0 && <span className="ml-1 text-yellow-600">+{deal.badgePremiumPct}%</span>}
                          </span>
                        ))}
                        {deal.serialMult > 1.1 && (
                          <span className="rounded bg-zinc-800 border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300">
                            🔢 {deal.serialMult}× serial
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Listed age */}
                    <td className="px-3 py-3">
                      <div className={`text-[11px] ${deal.isStale ? "text-red-500" : "text-zinc-500"}`}>
                        {listingAge(deal.updatedAt)}
                      </div>
                      {deal.isStale && (
                        <div className="text-[10px] text-red-600 mt-0.5">stale</div>
                      )}
                    </td>

                    {/* Action */}
                    <td className="px-3 py-3">
                      <a href={deal.buyUrl} target="_blank" rel="noopener noreferrer"
                        className="inline-block rounded-lg bg-red-600 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500 active:scale-95">
                        BUY →
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-4 text-center text-xs text-zinc-700">
          FMV adjusted for badge premiums and serial multipliers · Discount = (Adj. FMV − Ask) / Adj. FMV · Auto-refreshes every 30s
        </div>
      </div>
    </div>
  );
}