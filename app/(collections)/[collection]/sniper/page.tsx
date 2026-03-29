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
  parallelId: number;
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

interface OfferData {
  momentId: string;
  serialOffer: number | null;
  editionOffer: number | null;
  bestOffer: number | null;
}

interface WalletRow {
  flowId?: string;
  momentId?: string;
  isLocked?: boolean;
}

type SortKey = "listed" | "discount";

const TIER_COLOR: Record<string, string> = {
  COMMON: "text-zinc-400", RARE: "text-blue-400",
  LEGENDARY: "text-yellow-400", ULTIMATE: "text-purple-400",
  FANDOM: "text-pink-400",
};

const CONFIDENCE_COLOR: Record<string, string> = {
  high: "text-green-400", medium: "text-yellow-400",
  live: "text-cyan-400", "live-avg": "text-cyan-600",
  low: "text-zinc-500", very_low: "text-zinc-600",
};

const REFRESH_INTERVAL = 30_000;
const PAGE_SIZE = 50;

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

function listingAge(updatedAt: string | null): { label: string; fresh: boolean } {
  if (!updatedAt) return { label: "—", fresh: false };
  const ms = Date.now() - new Date(updatedAt).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return { label: "just now", fresh: true };
  if (mins < 5) return { label: `${mins}m ago`, fresh: true };
  if (mins < 60) return { label: `${mins}m ago`, fresh: false };
  return { label: `${Math.floor(mins / 60)}h ago`, fresh: false };
}

function SortHeader({
  label, sortKey, active, dir, onClick
}: { label: string; sortKey: SortKey; active: boolean; dir: "asc" | "desc"; onClick: () => void }) {
  return (
    <th className="p-3 cursor-pointer select-none hover:text-zinc-300 transition-colors"
      onClick={onClick}>
      <span className="flex items-center gap-1">
        {label}
        {active && <span className="text-red-400">{dir === "desc" ? " ↓" : " ↑"}</span>}
        {!active && <span className="text-zinc-700"> ↕</span>}
      </span>
    </th>
  );
}

export default function SniperPage() {
  const [deals, setDeals] = useState<SniperDeal[]>([]);
  const [offers, setOffers] = useState<Record<string, OfferData>>({});
  const [offersLoading, setOffersLoading] = useState(false);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL / 1000);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Sort state — default: newest listed first
  const [sortKey, setSortKey] = useState<SortKey>("listed");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Wallet
  const [walletInput, setWalletInput] = useState("");
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const [ownedFlowIds, setOwnedFlowIds] = useState<Map<string, boolean>>(new Map());

  // Filters — default minDiscount 0 since sort is by recency
  const [minDiscount, setMinDiscount] = useState(0);
  const [rarity, setRarity] = useState("all");
  const [badgeOnly, setBadgeOnly] = useState(false);
  const [serialFilter, setSerialFilter] = useState("all");
  const [maxPrice, setMaxPrice] = useState(0);
  const [searchText, setSearchText] = useState("");
  const [ownedFilter, setOwnedFilter] = useState("all");

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevIdsRef = useRef<Set<string>>(new Set());

  const fetchOffers = useCallback(async (dealList: SniperDeal[]) => {
    if (!dealList.length) return;
    setOffersLoading(true);
    try {
      const moments = dealList
        .map(d => ({
          momentId: d.momentId,
          setID: d.editionKey.split(":")[0],
          playID: d.editionKey.split(":")[1],
        }))
        .filter(m => m.setID && m.playID);
      const res = await fetch("/api/moment-offers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ moments }),
      });
      if (!res.ok) return;
      const data = await res.json();
      setOffers(data.offers ?? {});
    } catch (e) {
      console.warn("[sniper] offers fetch failed:", e);
    } finally {
      setOffersLoading(false);
    }
  }, []);

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
      setVisibleCount(PAGE_SIZE);
      setOffers({});
      fetchOffers(data.deals);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [minDiscount, rarity, badgeOnly, serialFilter, maxPrice, fetchOffers]);

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

  const loadWallet = useCallback(async () => {
    const w = walletInput.trim();
    if (!w) return;
    setWalletLoading(true); setWalletError(null);
    try {
      const res = await fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: w }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows: WalletRow[] = data.rows ?? [];
      const map = new Map<string, boolean>();
      for (const row of rows) {
        const fid = row.flowId ?? row.momentId;
        if (fid) map.set(String(fid), row.isLocked ?? false);
      }
      setOwnedFlowIds(map);
      setLoadedWallet(w);
    } catch (err) {
      setWalletError(err instanceof Error ? err.message : "Failed to load wallet");
    } finally {
      setWalletLoading(false);
    }
  }, [walletInput]);

  const clearWallet = () => {
    setOwnedFlowIds(new Map()); setLoadedWallet(null);
    setWalletInput(""); setOwnedFilter("all");
  };

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(d => d === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
    setVisibleCount(PAGE_SIZE);
  }

  // Filter
  const filtered = deals.filter(d => {
    if (ownedFilter === "owned" && !ownedFlowIds.has(d.flowId)) return false;
    if (ownedFilter === "not_owned" && ownedFlowIds.has(d.flowId)) return false;
    if (!searchText) return true;
    const q = searchText.toLowerCase();
    return d.playerName.toLowerCase().includes(q)
      || d.setName.toLowerCase().includes(q)
      || d.teamName.toLowerCase().includes(q)
      || d.parallel.toLowerCase().includes(q);
  });

  // Sort client-side
  const sorted = [...filtered].sort((a, b) => {
    let diff = 0;
    if (sortKey === "listed") {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      diff = tb - ta;
    } else {
      diff = b.discount - a.discount;
    }
    return sortDir === "desc" ? diff : -diff;
  });

  const visible = sorted.slice(0, visibleCount);

  const instantFlips = filtered.filter(d => {
    const o = offers[d.momentId];
    return o?.bestOffer != null && o.bestOffer > d.askPrice;
  }).length;

  const stats = {
    total: filtered.length,
    hot: filtered.filter(d => d.discount >= 40).length,
    badge: filtered.filter(d => d.hasBadge).length,
    serial: filtered.filter(d => d.isSpecialSerial).length,
    avgDiscount: filtered.length > 0
      ? Math.round(filtered.reduce((s, d) => s + d.discount, 0) / filtered.length) : 0,
  };

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1800px] px-3 py-4 md:px-6">

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

        {/* Title */}
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-white tracking-tight">🎯 Sniper</h2>
            <p className="text-sm text-zinc-500 mt-0.5">
              Live listings below FMV — badge-adjusted &amp; serial-premium aware
              {offersLoading && <span className="ml-2 text-zinc-600">· loading offers…</span>}
            </p>
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
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-6">
          {[
            { label: "Deals Found", value: stats.total },
            { label: "🔥 Hot (40%+ off)", value: stats.hot, hot: stats.hot > 0 },
            { label: "🏅 Badge Deals", value: stats.badge },
            { label: "🔢 Special Serials", value: stats.serial },
            { label: "Avg Discount", value: `${stats.avgDiscount}%` },
            { label: "⚡ Instant Flips", value: instantFlips, hot: instantFlips > 0 },
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
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-3">
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
                <option value="fandom">Fandom</option><option value="rare">Rare</option>
                <option value="legendary">Legendary</option><option value="ultimate">Ultimate</option>
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
                Ownership {loadedWallet && <span className="text-zinc-600 normal-case font-normal">({ownedFlowIds.size} moments)</span>}
              </label>
              <select value={ownedFilter} onChange={e => setOwnedFilter(e.target.value)}
                disabled={!loadedWallet}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40">
                <option value="all">All</option>
                <option value="owned">Owned Only</option>
                <option value="not_owned">Not Owned</option>
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Search</label>
              <input value={searchText} onChange={e => setSearchText(e.target.value)}
                placeholder="Player, set, team, parallel…"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-red-600" />
            </div>
          </div>

          {/* Wallet */}
          <div className="border-t border-zinc-800 pt-3">
            <label className="mb-1.5 block text-[11px] uppercase tracking-wide text-zinc-500">
              Wallet — load to see owned/locked status
            </label>
            {loadedWallet ? (
              <div className="flex items-center gap-3">
                <span className="text-sm text-green-400">✓ {loadedWallet}</span>
                <span className="text-xs text-zinc-600">{ownedFlowIds.size} moments tracked</span>
                <button onClick={clearWallet} className="rounded-lg border border-zinc-700 px-3 py-1 text-xs text-zinc-400 hover:bg-zinc-900">Clear</button>
              </div>
            ) : (
              <div className="flex gap-2">
                <input value={walletInput} onChange={e => setWalletInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && loadWallet()}
                  placeholder="Top Shot username or wallet address"
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-600 outline-none focus:border-red-600 max-w-sm" />
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
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">⚠ Error: {error}</div>
        )}

        {/* Table */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-950">
          <table className="w-full min-w-[1100px] border-collapse text-sm">
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
                <SortHeader label="Discount" sortKey="discount" active={sortKey === "discount"} dir={sortDir} onClick={() => handleSort("discount")} />
                <th className="p-3">Best Offer</th>
                <th className="p-3">Owned</th>
                <SortHeader label="Listed" sortKey="listed" active={sortKey === "listed"} dir={sortDir} onClick={() => handleSort("listed")} />
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
                  No deals found. Try adjusting your filters.
                </td></tr>
              )}
              {visible.map((deal, i) => {
                const badge = discountBadge(deal.discount);
                const isNew = newIds.has(deal.momentId);
                const tierColor = TIER_COLOR[deal.tier] ?? "text-zinc-400";
                const isOwned = ownedFlowIds.has(deal.flowId);
                const isOwnedLocked = isOwned && ownedFlowIds.get(deal.flowId) === true;
                const offerData = offers[deal.momentId];
                const bestOffer = offerData?.bestOffer ?? null;
                const isInstantFlip = bestOffer !== null && bestOffer > deal.askPrice;
                const flipProfit = isInstantFlip ? bestOffer - deal.askPrice : 0;
                const isNonBase = deal.parallelId > 0;
                const age = listingAge(deal.updatedAt);

                return (
                  <tr key={deal.momentId}
                    className={`border-b border-zinc-800/60 transition-all duration-300 hover:bg-zinc-900/50
                      ${isInstantFlip ? "bg-yellow-950/10 border-l-2 border-l-yellow-600" : deal.discount >= 40 ? "bg-green-950/10" : ""}
                      ${isNew ? "animate-pulse bg-yellow-950/20" : ""}`}>

                    <td className="px-3 py-2 text-xs text-zinc-600">{i + 1}</td>

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

                    {/* Player + badges inline */}
                    <td className="px-3 py-3">
                      <div className="font-semibold text-white leading-tight">{deal.playerName}</div>
                      <div className="text-[11px] text-zinc-500 mt-0.5 flex gap-1.5 flex-wrap">
                        {deal.teamName && <span>{deal.teamName}</span>}
                        {deal.seriesName && <span className="text-zinc-600">· {deal.seriesName}</span>}
                      </div>
                      {deal.hasBadge && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {deal.badgeLabels.map(label => (
                            <span key={label} className="rounded bg-yellow-900/40 border border-yellow-700/50 px-1 py-0.5 text-[10px] text-yellow-400 font-medium whitespace-nowrap">
                              🏅 {label}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Set + parallel under */}
                    <td className="px-3 py-3">
                      <div className="text-zinc-300 text-xs leading-tight">{deal.setName}</div>
                      {isNonBase && (
                        <div className="mt-0.5 text-[10px] text-zinc-500">{deal.parallel}</div>
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

                    {/* Best Offer */}
                    <td className="px-3 py-3">
                      {offersLoading && !offerData ? (
                        <div className="h-3 w-12 animate-pulse rounded bg-zinc-800" />
                      ) : isInstantFlip ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-yellow-400 font-bold text-sm">{fmt(bestOffer!)}</span>
                          <span className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold bg-yellow-900/50 border border-yellow-600 text-yellow-300">
                            ⚡ FLIP +{fmt(flipProfit)}
                          </span>
                          {offerData?.serialOffer === bestOffer && (
                            <span className="text-[10px] text-zinc-500">serial offer</span>
                          )}
                          {offerData?.editionOffer === bestOffer && offerData?.serialOffer !== bestOffer && (
                            <span className="text-[10px] text-zinc-500">edition offer</span>
                          )}
                        </div>
                      ) : bestOffer !== null ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="text-zinc-300 text-sm">{fmt(bestOffer)}</span>
                          {offerData?.serialOffer && (
                            <span className="text-[10px] text-zinc-600">serial: {fmt(offerData.serialOffer)}</span>
                          )}
                          {offerData?.editionOffer && offerData.editionOffer !== offerData.serialOffer && (
                            <span className="text-[10px] text-zinc-600">edition: {fmt(offerData.editionOffer)}</span>
                          )}
                        </div>
                      ) : offerData ? (
                        <span className="text-zinc-700 text-xs">no offers</span>
                      ) : (
                        <span className="text-zinc-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Owned */}
                    <td className="px-3 py-3">
                      {isOwned ? (
                        isOwnedLocked ? (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-orange-950/50 border border-orange-800 text-orange-400">
                            🔒 Locked
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold bg-green-950/50 border border-green-800 text-green-400">
                            ✓ Owned
                          </span>
                        )
                      ) : deal.isLocked ? (
                        <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-zinc-800 border border-zinc-700 text-zinc-500">
                          🔒 Locked
                        </span>
                      ) : (
                        <span className="text-zinc-700 text-xs">—</span>
                      )}
                    </td>

                    {/* Listed age */}
                    <td className="px-3 py-3">
                      <span className={`text-[11px] ${age.fresh ? "text-green-500" : "text-zinc-500"}`}>
                        {age.label}
                      </span>
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

        {/* Load more */}
        {sorted.length > visibleCount && (
          <div className="mt-4 flex items-center justify-center gap-4">
            <span className="text-xs text-zinc-600">
              Showing {visibleCount} of {sorted.length} listings
            </span>
            <button
              onClick={() => setVisibleCount(c => c + PAGE_SIZE)}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-900 transition">
              Show {Math.min(PAGE_SIZE, sorted.length - visibleCount)} more
            </button>
          </div>
        )}

        <div className="mt-4 text-center text-xs text-zinc-700">
          FMV adjusted for badge premiums and serial multipliers · Best Offer = highest of serial + edition offers · Sort by Listed or Discount
        </div>
      </div>
    </div>
  );
}