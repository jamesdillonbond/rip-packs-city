"use client";
import OffersTab from "@/components/sniper/OffersTab"

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useCart } from "@/lib/cart/CartContext";
import { getCollection } from "@/lib/collections";
import { getOwnerKey } from "@/lib/owner-key";

// ─── Constants ────────────────────────────────────────────────────────────────
const COMMISSION_RECIPIENT = "0xc1e4f4f4c4257510";

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
  paymentToken?: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount?: number | null;
  offerFmvPct?: number | null;
}

interface FeedResult {
  count: number;
  tsCount?: number;
  flowtyCount?: number;
  lastRefreshed: string;
  deals: SniperDeal[];
  cached?: boolean;
}

type SortOption =
  | "discount"
  | "price_asc"
  | "price_desc"
  | "fmv_desc"
  | "serial_asc"
  | "listed_desc";

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

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function tierColor(tier: string): string {
  switch (tier.toUpperCase()) {
    case "COMMON":    return "var(--tier-common)";
    case "FANDOM":    return "var(--tier-fandom)";
    case "RARE":      return "var(--tier-rare)";
    case "LEGENDARY": return "var(--tier-legendary)";
    case "ULTIMATE":  return "var(--tier-ultimate)";
    default:          return "var(--tier-common)";
  }
}

function holoClass(tier: string): string {
  switch (tier.toUpperCase()) {
    case "LEGENDARY": return "rpc-holo-legendary";
    case "ULTIMATE":  return "rpc-holo-ultimate";
    case "RARE":      return "rpc-holo-rare";
    default:          return "";
  }
}

function discountColor(pct: number) {
  if (pct >= 50) return "bg-red-500/20 text-red-300 border border-red-500/40";
  if (pct >= 30) return "bg-orange-500/20 text-orange-300 border border-orange-500/40";
  if (pct >= 15) return "bg-yellow-500/20 text-yellow-300 border border-yellow-500/40";
  if (pct >= 5)  return "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40";
  return "border";
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
    daysSinceSale === null || daysSinceSale === undefined ? "var(--rpc-text-ghost)"
    : daysSinceSale <= 3 ? "var(--rpc-success)"
    : daysSinceSale <= 14 ? "var(--rpc-warning)"
    : "var(--rpc-danger)";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <span
        className="inline-flex items-center gap-1 cursor-help"
        style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", letterSpacing: "0.1em", color: "var(--rpc-text-muted)" }}
        title={cfg.tip}
      >
        <span className={`inline-block w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
        {cfg.label}
      </span>
      {staleLabel && (
        <span style={{ fontSize: "var(--text-xs)", color: staleColor }} title={`Last sale ${staleLabel}`}>
          {staleLabel}
        </span>
      )}
    </div>
  );
}

function SerialBadge({ deal }: { deal: SniperDeal }) {
  if (!deal.isSpecialSerial && deal.serialMult <= 1) return null;
  return (
    <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.3)", color: "#c084fc" }}>
      {deal.serialSignal ?? `×${deal.serialMult.toFixed(1)}`}
    </span>
  );
}

function SourceBadge({ source, isAllDay }: { source?: "topshot" | "flowty"; isAllDay?: boolean }) {
  if (source === "flowty") {
    return (
      <span className="rpc-chip" style={{ background: "rgba(59,130,246,0.12)", borderColor: "rgba(59,130,246,0.25)", color: "var(--rpc-info)" }}>
        FLOWTY
      </span>
    );
  }
  return (
    <span className="rpc-chip" style={{ background: "var(--rpc-surface-raised)", color: "var(--rpc-text-muted)" }}>
      {isAllDay ? "AD" : "TS"}
    </span>
  );
}

const BADGE_SLUG_LABELS: Record<string, string> = {
  rookie_year: "Rookie Year",
  top_shot_debut: "TS Debut",
  championship_year: "Champ Year",
  three_star_rookie: "Three-Star",
  jersey_match: "#Jersey",
  perfect_mint: "PM",
  number_one: "#1",
};

const BADGE_SLUG_COLORS: Record<string, string> = {
  rookie_year: "bg-red-500/15 text-red-400 border-red-500/25",
  top_shot_debut: "bg-white/10 text-black border-white/25",
  championship_year: "bg-zinc-500/15 text-zinc-400 border-zinc-500/25",
  three_star_rookie: "bg-yellow-500/15 text-yellow-400 border-yellow-500/25",
  jersey_match: "bg-blue-500/15 text-blue-400 border-blue-500/25",
  perfect_mint: "bg-green-500/15 text-green-400 border-green-500/25",
  number_one: "bg-amber-500/15 text-amber-400 border-amber-500/25",
};

function BadgePills({ slugs }: { slugs: string[] }) {
  return (
    <div className="flex gap-1 mt-1 flex-wrap">
      {slugs.map((slug) => (
        <span
          key={slug}
          className={`px-1 py-0.5 rounded text-xs border ${BADGE_SLUG_COLORS[slug] ?? "bg-yellow-500/15 text-yellow-400 border-yellow-500/25"}`}
        >
          {BADGE_SLUG_LABELS[slug] ?? slug}
        </span>
      ))}
    </div>
  );
}

function ShareButton({ deal }: { deal: SniperDeal }) {
  const [copied, setCopied] = useState(false);

  function handleShare() {
    const url = window.location.origin + window.location.pathname + "?highlight=" + deal.flowId;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  return (
    <button
      onClick={handleShare}
      className="rpc-chip"
      style={{ padding: "3px 8px" }}
      title="Copy deal link"
    >
      {copied ? "✓" : "⎘"}
    </button>
  );
}

function ActionCell({
  deal,
  ownedIds,
  connectedWallet,
  accent,
  offerMode,
  offerDurationDays,
}: {
  deal: SniperDeal;
  ownedIds: Set<string>;
  connectedWallet: string | null;
  accent: string;
  offerMode: boolean;
  offerDurationDays: number;
}) {
  const { addToCart, addOffer, removeFromCart, isInCart } = useCart();
  const [localOfferAmt, setLocalOfferAmt] = useState<number>(
    Math.round(deal.adjustedFmv * 0.8 * 100) / 100
  );
  const inCart = deal.listingResourceID ? isInCart(deal.listingResourceID) : false;
  const isOwned = ownedIds.has(String(deal.momentId)) || ownedIds.has(String(deal.flowId));
  const canCart = !!deal.listingResourceID && !!deal.storefrontAddress;
  const isFlowty = (deal.source ?? "topshot") === "flowty";

  function handleCart() {
    if (!canCart) return;
    if (inCart) {
      removeFromCart(deal.listingResourceID!);
      return;
    }

    if (offerMode) {
      // Add as offer item
      const expiryTimestamp = Math.floor(Date.now() / 1000) + offerDurationDays * 24 * 60 * 60;
      addOffer({
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
        paymentToken: "USDC_E",
        offerAmount: localOfferAmt,
        offerExpiry: expiryTimestamp,
      });
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
        paymentToken: deal.paymentToken ?? "DUC",
        cartMode: "buy",
      });
    }
  }

  function handleBuy() {
    trackClick(deal, connectedWallet);
  }

  if (isOwned) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="rpc-chip" style={{ color: "var(--rpc-text-muted)" }}>
          ✓ OWNED
        </span>
        <a
          href={deal.buyUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={handleBuy}
          className="rpc-chip"
          style={{ color: "var(--rpc-text-muted)", textDecoration: "none" }}
        >
          VIEW →
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Offer amount input — shown when offer mode is active */}
      {offerMode && canCart && !inCart && (
        <div className="flex items-center gap-1">
          <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>$</span>
          <input
            type="number"
            min={0.01}
            step={0.01}
            value={localOfferAmt}
            onChange={(e) => setLocalOfferAmt(Number(e.target.value))}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 64,
              background: "var(--rpc-surface-raised)",
              border: "1px solid rgba(59,130,246,0.3)",
              borderRadius: "var(--radius-sm)",
              padding: "3px 6px",
              color: "var(--rpc-text-primary)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-xs)",
              outline: "none",
              textAlign: "right",
            }}
          />
        </div>
      )}
      {canCart && (
        <button
          onClick={handleCart}
          className="rpc-chip"
          style={inCart
            ? { background: "rgba(52,211,153,0.15)", borderColor: "rgba(52,211,153,0.4)", color: "var(--rpc-success)" }
            : offerMode
            ? { background: "rgba(59,130,246,0.10)", borderColor: "rgba(59,130,246,0.4)", color: "var(--rpc-info)" }
            : { color: "var(--rpc-text-secondary)" }
          }
        >
          {inCart ? "✓ IN CART" : offerMode ? "+ OFFER" : "+ CART"}
        </button>
      )}
      <a
        href={deal.buyUrl}
        target="_blank"
        rel="noopener noreferrer"
        onClick={handleBuy}
        className={isFlowty ? "rpc-chip" : "rpc-btn-ghost"}
        style={isFlowty
          ? { background: "rgba(59,130,246,0.15)", borderColor: "rgba(59,130,246,0.4)", color: "var(--rpc-info)", textDecoration: "none", padding: "4px 12px" }
          : { padding: "4px 12px", textDecoration: "none", borderColor: `${accent}40`, color: accent }
        }
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
  { value: "listed_desc", label: "Recently Listed" },
  { value: "discount",    label: "Best Discount" },
  { value: "price_asc",   label: "Cheapest First" },
  { value: "price_desc",  label: "Most Expensive" },
  { value: "fmv_desc",    label: "Highest FMV" },
  { value: "serial_asc",  label: "Lowest Serial" },
];

export default function SniperPage() {
  const routeParams = useParams();
  const collectionSlug = routeParams.collection as string;
  const collectionObj = getCollection(collectionSlug);
  const accent = collectionObj?.accent ?? "#E03A2F";
  const isAllDay = collectionSlug === "nfl-all-day";
  const feedEndpoint = isAllDay ? "/api/allday-sniper-feed" : "/api/sniper-feed";
  const brandLabel = collectionObj?.shortLabel ?? "Top Shot";

  const [data, setData] = useState<FeedResult | null>(null);
  const [mode, setMode] = useState<"deals" | "offers">("deals");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [paused, setPaused] = useState(false);

  const [connectedWallet, setConnectedWallet] = useState<string | null>(null);
  const [ownedIds, setOwnedIds] = useState<Set<string>>(new Set());

  const [tierTab, setTierTab] = useState<TierTab>("all");
  const [sortBy, setSortBy] = useState<SortOption>("listed_desc");
  const [minDiscount, setMinDiscount] = useState(0);
  const [maxPrice, setMaxPrice] = useState(0);
  const [serialFilter, setSerialFilter] = useState("all");
  const [badgeOnly, setBadgeOnly] = useState(false);
  const [flowWalletOnly, setFlowWalletOnly] = useState(false);
  const [offerMode, setOfferMode] = useState(false);
  const [offerDurationDays, setOfferDurationDays] = useState(30);
  const [search, setSearch] = useState("");
  const [showVerifiedOnly, setShowVerifiedOnly] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [editionStats, setEditionStats] = useState<Map<string, { owned: number; locked: number }>>(new Map());
  const editionStatsFetchedRef = useRef<string | null>(null);

  // Highlight detection on page load
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("highlight");
    if (id) setHighlightedId(id);
  }, []);

  // Player filter with 300ms debounce
  const [playerInput, setPlayerInput] = useState("");
  const [playerFilter, setPlayerFilter] = useState("");
  const playerDebounceRef = useRef<NodeJS.Timeout | null>(null);

  const handlePlayerChange = useCallback((value: string) => {
    setPlayerInput(value);
    if (playerDebounceRef.current) clearTimeout(playerDebounceRef.current);
    playerDebounceRef.current = setTimeout(() => {
      setPlayerFilter(value.trim());
    }, 300);
  }, []);

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

  // Fall back to owner key if FCL wallet isn't connected
  useEffect(() => {
    if (!connectedWallet) {
      const key = getOwnerKey();
      if (key) setConnectedWallet(key);
    }
  }, [connectedWallet]);

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

  // Fetch edition-level owned/locked stats for the connected wallet
  useEffect(() => {
    if (!connectedWallet || editionStatsFetchedRef.current === connectedWallet) return;
    editionStatsFetchedRef.current = connectedWallet;
    let cancelled = false;

    async function loadEditionStats() {
      try {
        // Load all wallet moments to build edition stats
        const allRows: Array<{ editionKey?: string; isLocked?: boolean; locked?: boolean }> = [];
        let offset = 0;
        const limit = 50;
        let remaining = 1; // start with 1 to enter loop

        for (let page = 0; page < 10 && remaining > 0; page++) {
          const res = await fetch("/api/wallet-search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ input: connectedWallet, offset, limit }),
          });
          if (!res.ok || cancelled) break;
          const json = await res.json();
          const rows = json.rows ?? [];
          allRows.push(...rows);
          remaining = json.summary?.remainingMoments ?? 0;
          offset += rows.length;
          if (rows.length === 0) break;
        }

        if (cancelled) return;

        // Build edition stats map
        const statsMap = new Map<string, { owned: number; locked: number }>();
        for (const row of allRows) {
          const key = row.editionKey ?? "";
          if (!key) continue;
          const current = statsMap.get(key) ?? { owned: 0, locked: 0 };
          current.owned += 1;
          if (row.isLocked || row.locked) current.locked += 1;
          statsMap.set(key, current);
        }
        setEditionStats(statsMap);
      } catch {}
    }
    loadEditionStats();
    return () => { cancelled = true; };
  }, [connectedWallet]);

  const buildFeedUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (tierTab !== "all") params.set("tier", tierTab);
    if (minDiscount > 0) params.set("minDiscount", String(minDiscount));
    if (maxPrice > 0) params.set("maxPrice", String(maxPrice));
    if (playerFilter) params.set("player", playerFilter);
    if (serialFilter !== "all") params.set("serial", serialFilter);
    if (badgeOnly) params.set("badgeOnly", "true");
    if (flowWalletOnly) params.set("flowWalletOnly", "true");
    params.set("sortBy", sortBy);
    return `${feedEndpoint}?${params}`;
  }, [tierTab, minDiscount, maxPrice, playerFilter, serialFilter, badgeOnly, flowWalletOnly, sortBy, feedEndpoint]);

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
    if (d.discount < 0) return false;
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
    tsCached: !!(data?.cached) && (data?.tsCount ?? 0) === 0,
    flowtyLive: (data?.flowtyCount ?? 0) > 0,
  };

  return (
    <div className="rpc-binder-bg" style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      {/* ── Header ── */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)", padding: "16px" }}>
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="rpc-heading flex items-center gap-2" style={{ fontSize: "var(--text-xl)" }}>
                <span style={{ fontSize: "var(--text-2xl)" }}>⚡</span> SNIPER
              </h1>
              <p className="rpc-label" style={{ marginTop: 2 }}>
                LIVE DEALS BELOW ADJUSTED FMV — BADGE-AWARE, SERIAL-ADJUSTED
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={`rpc-chip ${stats.tsCached ? "text-amber-400 border-amber-500/30 bg-amber-500/10" : ""}`} style={stats.tsLive
                  ? { background: "rgba(52,211,153,0.08)", borderColor: "rgba(52,211,153,0.3)", color: "var(--rpc-success)" }
                  : stats.tsCached
                  ? {}
                  : { background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.2)", color: "var(--rpc-danger)" }
                }>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${stats.tsLive ? "bg-emerald-400 animate-pulse" : stats.tsCached ? "bg-amber-400 animate-pulse" : "bg-red-400/50"}`} style={{ marginRight: 4 }} />
                  {isAllDay ? "AD" : "TS"} {stats.tsLive ? `(${data?.tsCount})` : stats.tsCached ? "CACHED" : "OFFLINE"}
                </span>
                <span className="rpc-chip" style={stats.flowtyLive
                  ? { background: "rgba(59,130,246,0.08)", borderColor: "rgba(59,130,246,0.3)", color: "var(--rpc-info)" }
                  : { background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.2)", color: "var(--rpc-danger)" }
                }>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${stats.flowtyLive ? "bg-blue-400 animate-pulse" : "bg-red-400/50"}`} style={{ marginRight: 4 }} />
                  FLOWTY {stats.flowtyLive ? `(${data?.flowtyCount})` : "OFFLINE"}
                </span>
              </div>
              <button
                onClick={() => setPaused((p) => !p)}
                className="rpc-chip"
              >
                {paused ? "▶ RESUME" : `⏸ ${countdown}s`}
              </button>
              <button
                onClick={() => { fetchFeed(); setCountdown(REFRESH_INTERVAL); }}
                disabled={loading}
                className="rpc-btn-ghost"
                style={{ opacity: loading ? 0.5 : 1, borderColor: `${accent}40`, color: accent }}
              >
                {loading ? "↻" : "↻ REFRESH"}
              </button>
            </div>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-2 mb-4">
            {(["deals", "offers"] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)}
                className={`rpc-chip ${mode === m ? "active" : ""}`}
                style={mode === m ? { background: `${accent}1A`, borderColor: `${accent}66`, color: accent } : undefined}>
                {m === "deals" ? "⚡ DEALS" : "🤝 OFFERS"}
              </button>
            ))}
          </div>
          {mode === "offers" && <OffersTab />}
          {mode === "deals" && (
          <>
          {/* ── Primary Filters (Tier dropdown, Player input, Min Discount %) ── */}
          <div className="flex flex-wrap items-center gap-3 mb-4" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
            <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)" }}>
              <span>TIER</span>
              <select
                value={tierTab}
                onChange={(e) => setTierTab(e.target.value as TierTab)}
                style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 10px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none", textTransform: "uppercase" }}
              >
                <option value="all">All</option>
                <option value="common">Common</option>
                <option value="rare">Rare</option>
                <option value="legendary">Legendary</option>
                <option value="ultimate">Ultimate</option>
                <option value="fandom">Fandom</option>
              </select>
            </label>
            <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)" }}>
              <span>PLAYER</span>
              <input
                type="text"
                placeholder="e.g. LeBron"
                value={playerInput}
                onChange={(e) => handlePlayerChange(e.target.value)}
                style={{ width: 160, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
              />
            </label>
            <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)" }}>
              <span>MIN DISC.</span>
              <input
                type="number"
                min={0} max={100} step={5}
                value={minDiscount}
                onChange={(e) => setMinDiscount(Number(e.target.value))}
                placeholder="0"
                style={{ width: 56, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
              />
              <span>%</span>
            </label>
          </div>

          {/* Tier quick tabs */}
          <div className="flex items-center gap-1 mb-4 flex-wrap">
            {TIER_TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTierTab(t)}
                className={`rpc-chip ${tierTab === t ? "active" : ""}`}
                style={tierTab === t ? { textTransform: "uppercase", background: `${accent}1A`, borderColor: `${accent}66`, color: accent } : { textTransform: "uppercase" }}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Advanced Filters */}
          <div className="flex flex-wrap items-center gap-3" style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
            <input
              type="text"
              placeholder="Search player, set, team…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", width: 200, outline: "none" }}
            />
            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
              <span>MAX $</span>
              <input
                type="number"
                min={0} step={1}
                value={maxPrice || ""}
                onChange={(e) => setMaxPrice(Number(e.target.value))}
                placeholder="any"
                style={{ width: 72, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
              />
            </label>
            <select
              value={serialFilter}
              onChange={(e) => setSerialFilter(e.target.value)}
              style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
            >
              <option value="all">All serials</option>
              <option value="special">Special only</option>
              <option value="jersey">Jersey match</option>
            </select>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortOption)}
              style={{ background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
              <input
                type="checkbox"
                checked={badgeOnly}
                onChange={(e) => setBadgeOnly(e.target.checked)}
              />
              BADGES ONLY
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
              <input
                type="checkbox"
                checked={showVerifiedOnly}
                onChange={(e) => setShowVerifiedOnly(e.target.checked)}
              />
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                VERIFIED FMV ONLY
              </span>
            </label>
            <button
              onClick={() => setFlowWalletOnly((v) => !v)}
              className={`rpc-chip ${flowWalletOnly ? "active" : ""}`}
              title="FLOW &amp; USDC.e listings only — no Dapper Wallet needed."
              style={flowWalletOnly ? { background: "rgba(0,232,130,0.10)", borderColor: "rgba(0,232,130,0.40)", color: "#00e882" } : {}}
            >
              <span className="inline-flex items-center gap-1.5">
                {/* Flow logo — lightning bolt */}
                <svg width="10" height="12" viewBox="0 0 10 12" fill="none" style={{ flexShrink: 0 }}>
                  <path d="M6 0L0 7h4l-1 5 7-7H6l1-5z" fill="currentColor" />
                </svg>
                FLOW WALLET
              </span>
            </button>
            <button
              onClick={() => setOfferMode((v) => !v)}
              className={`rpc-chip ${offerMode ? "active" : ""}`}
              title="Add items as Flowty offers instead of direct purchases."
              style={offerMode ? { background: "rgba(59,130,246,0.10)", borderColor: "rgba(59,130,246,0.40)", color: "var(--rpc-info)" } : {}}
            >
              <span className="inline-flex items-center gap-1.5">
                OFFER MODE
              </span>
            </button>
            {offerMode && (
              <label className="flex items-center gap-1.5" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
                <span>DURATION</span>
                <select
                  value={offerDurationDays}
                  onChange={(e) => setOfferDurationDays(Number(e.target.value))}
                  style={{
                    background: "var(--rpc-surface-raised)",
                    border: "1px solid rgba(59,130,246,0.3)",
                    borderRadius: "var(--radius-sm)",
                    padding: "4px 8px",
                    color: "var(--rpc-text-primary)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--text-xs)",
                    outline: "none",
                  }}
                >
                  <option value={7}>7 days</option>
                  <option value={14}>14 days</option>
                  <option value={30}>30 days</option>
                  <option value={60}>60 days</option>
                  <option value={90}>90 days</option>
                </select>
              </label>
            )}
            {flowWalletOnly && !offerMode && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}>
                FLOW &amp; USDC.e listings only — no Dapper Wallet needed.
              </span>
            )}
            {offerMode && (
              <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}>
                Click + OFFER to add deals as Flowty USDC.e offers.
              </span>
            )}
          </div>
        </>)}
        </div>
      </div>

      {mode === "deals" && (<>
      {/* Stats bar */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
        <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
          <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.total}</span> deals</span>
          <span><span style={{ color: "var(--rpc-danger)", fontWeight: 600 }}>{stats.hot}</span> hot (40%+)</span>
          {stats.badge > 0 && (
            <span><span style={{ color: "var(--tier-legendary)", fontWeight: 600 }}>{stats.badge}</span> badged</span>
          )}
          {stats.special > 0 && (
            <span><span style={{ color: "#c084fc", fontWeight: 600 }}>{stats.special}</span> special serials</span>
          )}
          <span>avg <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{fmt(stats.avgDiscount, 1)}%</span> off</span>
          {connectedWallet && ownedIds.size > 0 && (
            <span style={{ color: "var(--rpc-text-ghost)" }}>{ownedIds.size} owned moments tracked</span>
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
      <div style={{ maxWidth: "var(--max-width)", margin: "0 auto", padding: "16px" }}>
        {error && (
          <div className="rpc-hud" style={{ marginBottom: 16, borderColor: "var(--rpc-danger)", color: "var(--rpc-danger)", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)" }}>
            FEED ERROR: {error}
          </div>
        )}

        {data?.cached && (
          <div className="rpc-hud" style={{ marginBottom: 16, borderColor: "var(--rpc-warning)", color: "var(--rpc-warning)", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)" }}>
            LIVE FEEDS OFFLINE — SHOWING CACHED DEALS. PRICES MAY BE STALE.
          </div>
        )}

        {loading && !data && (
          <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
            {[100, 85, 70, 55, 40].map((w, i) => (
              <div key={i} className="rpc-skeleton" style={{ width: `${w}%`, height: 14, opacity: 1 - i * 0.15 }} />
            ))}
            <p className="rpc-label" style={{ marginTop: 12 }}>SCANNING THE MARKETPLACE…</p>
          </div>
        )}

        {!loading && visibleDeals.length === 0 && data && (
          <div style={{ padding: "80px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center" }}>
            <svg width="40" height="40" viewBox="0 0 100 100" style={{ opacity: 0.3 }}>
              <circle cx="50" cy="50" r="46" fill="none" stroke={accent} strokeWidth="4" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill={accent} transform="rotate(0 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill={accent} transform="rotate(72 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill={accent} transform="rotate(144 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill={accent} transform="rotate(216 50 50)" />
              <path d="M50 50 L50 8 A18 18 0 0 1 72 32 Z" fill={accent} transform="rotate(288 50 50)" />
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <p className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>THE FLOOR IS QUIET</p>
            <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)" }}>No deals match your filters. Try widening your search.</p>
            <button
              onClick={() => {
                setTierTab("all"); setMinDiscount(0); setMaxPrice(0);
                setSerialFilter("all"); setBadgeOnly(false);
                setFlowWalletOnly(false); setShowVerifiedOnly(false); setSearch("");
              }}
              className="rpc-btn-ghost" style={{ marginTop: 8, borderColor: `${accent}66`, color: accent }}
            >
              CLEAR FILTERS
            </button>
          </div>
        )}

        {visibleDeals.length > 0 && (
          <div className="rpc-card" style={{ overflow: "auto", borderRadius: "var(--radius-md)" }}>
            <table style={{ width: "100%", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)", borderCollapse: "collapse" }}>
              <thead>
                <tr className="rpc-thead-scanline" style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
                  <th className="rpc-label" style={{ textAlign: "left", padding: "10px 12px", width: 40 }} />
                  <th className="rpc-label" style={{ textAlign: "left", padding: "10px 12px" }}>Moment</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Serial</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Listed</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Own / Lock</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Ask</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Adj. FMV</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Discount</th>
                  <th className="rpc-label" style={{ textAlign: "center", padding: "10px 4px", width: 36 }} />
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleDeals.map((deal) => (
                  <tr
                    key={`${deal.source}-${deal.flowId}-${deal.listingResourceID}`}
                    className={`${holoClass(deal.tier)}${deal.flowId === highlightedId ? " ring-2" : ""}${deal.discount >= 40 ? " rpc-hot-deal" : ""}`}
                    style={{ borderBottom: "1px solid var(--rpc-border)", transition: "background var(--transition-fast)", ...(deal.flowId === highlightedId ? { boxShadow: `0 0 0 2px ${accent}80`, background: `${accent}12` } : {}) }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--rpc-surface-hover)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = deal.discount >= 40 ? "rgba(224,58,47,0.08)" : "transparent"; }}
                  >
                    {/* Thumbnail */}
                    <td style={{ padding: "8px 12px" }}>
                      {deal.thumbnailUrl ? (
                        <img
                          src={deal.thumbnailUrl}
                          alt={deal.playerName}
                          style={{ width: 36, height: 36, objectFit: "cover", objectPosition: "top center", borderRadius: 4, display: "block" }}
                          loading="lazy"
                        />
                      ) : (
                        <div style={{ width: 36, height: 36, borderRadius: 4, background: "var(--rpc-surface-raised)" }} />
                      )}
                    </td>

                    {/* Moment info */}
                    <td style={{ padding: "8px 12px" }}>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", lineHeight: 1.2 }}>{deal.playerName}</div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap" style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
                        <span className={deal.tier.toUpperCase() === "LEGENDARY" ? "rpc-tier-glow-legendary" : deal.tier.toUpperCase() === "ULTIMATE" ? "rpc-tier-glow-ultimate" : deal.tier.toUpperCase() === "RARE" ? "rpc-tier-glow-rare" : ""} style={{ color: tierColor(deal.tier), fontWeight: 600 }}>
                          {deal.tier.charAt(0) + deal.tier.slice(1).toLowerCase()}
                        </span>
                        {deal.parallel !== "Base" && (
                          <span style={{ color: "var(--rpc-text-muted)" }}>{deal.parallel}</span>
                        )}
                        <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
                        <span style={{ color: "var(--rpc-text-muted)" }}>{deal.setName}</span>
                        {deal.seriesName && (
                          <>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>{deal.seriesName}</span>
                          </>
                        )}
                        {deal.teamName && (
                          <>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
                            <span style={{ color: "var(--rpc-text-ghost)" }}>{deal.teamName}</span>
                          </>
                        )}
                      </div>
                      {deal.hasBadge && deal.badgeSlugs.length > 0 && (
                        <BadgePills slugs={deal.badgeSlugs} />
                      )}
                      {deal.offerAmount != null && deal.offerAmount > 0 && (
                        <div className="flex gap-1 mt-1 flex-wrap">
                          {deal.offerFmvPct != null && deal.offerFmvPct >= 100 ? (
                            <span className="px-1 py-0.5 rounded text-xs bg-red-500/20 text-red-300 border border-red-500/40 font-bold">
                              🔥 Offer above ask
                            </span>
                          ) : (
                            <span className="px-1 py-0.5 rounded text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/25">
                              💰 Offer: ${deal.offerAmount.toFixed(2)}
                            </span>
                          )}
                        </div>
                      )}
                    </td>

                    {/* Serial */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <div style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)" }}>#{deal.serial}</div>
                      {deal.circulationCount > 0 && (
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>/ {deal.circulationCount.toLocaleString()}</div>
                      )}
                      {deal.isSpecialSerial && <SerialBadge deal={deal} />}
                    </td>

                    {/* Listed */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
                      {timeAgo(deal.updatedAt)}
                    </td>

                    {/* Own / Lock */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
                      {(() => {
                        if (!connectedWallet) return "—";
                        const isOwned = ownedIds.has(String(deal.momentId)) || ownedIds.has(String(deal.flowId));
                        if (isOwned) return <span style={{ color: "var(--rpc-success)" }}>✓ OWN</span>;
                        if (deal.isLocked) return <span title="Locked">🔒</span>;
                        return "—";
                      })()}
                    </td>

                    {/* Ask */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--rpc-text-primary)" }}>
                      ${fmt(deal.askPrice)}
                    </td>

                    {/* Adjusted FMV */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <div style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4 }}>
                        ${fmt(deal.adjustedFmv)}
                        {deal.wapUsd !== null && deal.wapUsd > 0 && (() => {
                          const diff = (deal.wapUsd - deal.baseFmv) / deal.baseFmv;
                          if (Math.abs(diff) < 0.1) return null;
                          return diff > 0
                            ? <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-success)" }} title={`WAP $${fmt(deal.wapUsd)} — trending up`}>↑</span>
                            : <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-danger)" }} title={`WAP $${fmt(deal.wapUsd)} — trending down`}>↓</span>;
                        })()}
                      </div>
                      {deal.serialMult > 1 && (
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
                          base ${fmt(deal.baseFmv)} × {deal.serialMult.toFixed(2)}
                        </div>
                      )}
                    </td>

                    {/* Discount */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${discountColor(deal.discount)}`} style={{ fontFamily: "var(--font-mono)" }}>
                        {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                      </span>
                    </td>

                    {/* Share */}
                    <td style={{ padding: "8px 4px", textAlign: "center" }}>
                      <ShareButton deal={deal} />
                    </td>

                    {/* Action */}
                    <td style={{ padding: "8px 12px" }}>
                      <ActionCell
                        deal={deal}
                        ownedIds={ownedIds}
                        connectedWallet={connectedWallet}
                        accent={accent}
                        offerMode={offerMode}
                        offerDurationDays={offerDurationDays}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Legend */}
        <div className="rpc-mono flex items-center gap-4 flex-wrap" style={{ marginTop: 16, color: "var(--rpc-text-ghost)" }}>
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
          <span style={{ color: "var(--rpc-success)" }}>↑</span>
          <span>WAP trending up &nbsp;</span>
          <span style={{ color: "var(--rpc-danger)" }}>↓</span>
          <span>WAP trending down</span>
          <span className="ml-auto">Adj. FMV = base FMV × serial multiplier</span>
        </div>
      </div>
      </>)}
    </div>
  );
}