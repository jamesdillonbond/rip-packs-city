"use client";
import OffersTab from "@/components/sniper/OffersTab"
import React from "react";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import { useCart } from "@/lib/cart/CartContext";
import { getCollection } from "@/lib/collections";
import { getOwnerKey } from "@/lib/owner-key";
import { PINNACLE_VARIANT_COLORS, PINNACLE_VARIANT_LABELS } from "@/lib/pinnacle/pinnacleTypes";
import MomentDetailModal from "@/components/MomentDetailModal";

function SniperThumbnailPreview({ thumbUrl, playerName, tierColor, children }: { thumbUrl: string | null; playerName: string; tierColor: string; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  const previewUrl = thumbUrl ? thumbUrl.replace(/width=\d+/, "width=400") : null;
  function onEnter() {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const x = Math.min(window.innerWidth - 240, r.right + 12);
    const y = Math.max(12, r.top - 40);
    setPos({ x, y });
    setHovered(true);
  }
  return (
    <div ref={ref} onMouseEnter={onEnter} onMouseLeave={() => setHovered(false)} style={{ display: "inline-block" }}>
      {children}
      {hovered && previewUrl && pos && (
        <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 500, pointerEvents: "none", background: "#000", border: `2px solid ${tierColor}`, borderRadius: 6, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
          <img src={previewUrl} alt={playerName} width={200} height={200} style={{ width: 200, height: 200, objectFit: "contain", display: "block" }} />
          <div style={{ color: "#fff", fontSize: 11, marginTop: 4, textAlign: "center", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{playerName}</div>
        </div>
      )}
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────────────────────
const COMMISSION_RECIPIENT = "0xc1e4f4f4c4257510";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SniperDeal {
  flowId: string;
  momentId: string;
  editionKey: string;
  intEditionKey?: string | null;
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
  source?: "topshot" | "flowty" | "pinnacle";
  paymentToken?: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount?: number | null;
  offerFmvPct?: number | null;
  dealRating?: number;
  isLowestAsk?: boolean;
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
    case "UNCOMMON":  return "var(--tier-uncommon)";
    case "LEGENDARY": return "var(--tier-legendary)";
    case "ULTIMATE":  return "var(--tier-ultimate)";
    case "CHAMPION":   return "var(--tier-champion)";
    case "CHALLENGER": return "var(--tier-challenger)";
    case "CONTENDER":  return "var(--tier-contender)";
    default:          return "var(--tier-common)";
  }
}

function variantColor(variant: string): string {
  return PINNACLE_VARIANT_COLORS[variant] ?? "#9CA3AF";
}

function variantLabel(variant: string): string {
  return PINNACLE_VARIANT_LABELS[variant] ?? variant;
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

function SourceBadge({ source, isAllDay }: { source?: "topshot" | "flowty" | "pinnacle"; isAllDay?: boolean }) {
  if (source === "pinnacle") {
    return (
      <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.12)", borderColor: "rgba(168,85,247,0.25)", color: "#c084fc" }}>
        PINNACLE
      </span>
    );
  }
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

function BadgeIcon({ slug, size = 18 }: { slug: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  const label = BADGE_SLUG_LABELS[slug] ?? slug;
  const url = `https://nbatopshot.com/img/momentTags/static/${slug}.svg`;
  if (errored) {
    return (
      <span
        className={`px-1 py-0.5 rounded text-[10px] border ${BADGE_SLUG_COLORS[slug] ?? "bg-yellow-500/15 text-yellow-400 border-yellow-500/25"}`}
      >
        {label}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt={label}
      title={label}
      width={size}
      height={size}
      loading="lazy"
      onError={() => setErrored(true)}
      style={{ width: size, height: size, display: "inline-block", verticalAlign: "middle" }}
    />
  );
}

function BadgePills({ slugs }: { slugs: string[] }) {
  // Dedupe slugs to avoid double-rendered badges when upstream data repeats entries.
  const unique = Array.from(new Set(slugs));
  return (
    <div className="flex gap-1 mt-1 flex-wrap items-center">
      {unique.map((slug) => (
        <BadgeIcon key={slug} slug={slug} />
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
  accent,
  offerMode,
  offerDurationDays,
}: {
  deal: SniperDeal;
  ownedIds: Set<string>;
  accent: string;
  offerMode: boolean;
  offerDurationDays: number;
}) {
  const { addToCart, addOffer, removeFromCart, isInCart } = useCart();
  const [localOfferAmt, setLocalOfferAmt] = useState<number>(
    Math.round(deal.adjustedFmv * 0.8 * 100) / 100
  );
  const inCart = deal.listingResourceID ? isInCart(deal.listingResourceID) : false;
  // ownedIds contains integer setID:playID edition keys from on-chain Cadence.
  // Match against intEditionKey first (always integer-format) and fall back
  // to editionKey for any deal where the two happen to coincide.
  const isOwned =
    (!!deal.intEditionKey && ownedIds.has(deal.intEditionKey)) ||
    (!!deal.editionKey && ownedIds.has(deal.editionKey));
  const isPinnacleDeal = deal.source === "pinnacle";
  const canCart = !!deal.listingResourceID && !!deal.storefrontAddress && !isPinnacleDeal;
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
    trackClick(deal, null);
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
        className={isFlowty || isPinnacleDeal ? "rpc-chip" : "rpc-btn-ghost"}
        style={isPinnacleDeal
          ? { background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.4)", color: "#c084fc", textDecoration: "none", padding: "4px 12px" }
          : isFlowty
          ? { background: "rgba(59,130,246,0.15)", borderColor: "rgba(59,130,246,0.4)", color: "var(--rpc-info)", textDecoration: "none", padding: "4px 12px" }
          : { padding: "4px 12px", textDecoration: "none", borderColor: `${accent}40`, color: accent }
        }
      >
        {isPinnacleDeal ? "BUY ON PINNACLE →" : isFlowty ? "FLOWTY →" : "BUY →"}
      </a>
    </div>
  );
}

// ─── useMobile hook ──────────────────────────────────────────────────────────

function useMobile() {
  const [isMobile, setIsMobile] = useState(true);
  useEffect(() => {
    setIsMobile(window.innerWidth < 768);
    function onResize() { setIsMobile(window.innerWidth < 768); }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}

// ─── Main page ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 30;
const TIER_TABS = ["all", "common", "uncommon", "fandom", "rare", "legendary", "ultimate"] as const;
const GOLAZOS_TIER_TABS = ["all", "common", "fandom", "uncommon", "rare", "legendary"] as const;
const PINNACLE_VARIANT_TABS = ["all", "Standard", "Brushed Silver", "Colored Enamel", "Golden", "Digital Display", "Limited Edition"] as const;
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
  const isPinnacle = collectionSlug === "pinnacle" || collectionSlug === "disney-pinnacle";
  const isGolazos = collectionSlug === "laliga-golazos";
  const isUfc = collectionSlug === "ufc";
  const feedEndpoint = isPinnacle
    ? "/api/pinnacle-sniper"
    : isGolazos
    ? "/api/golazos-sniper-feed"
    : isUfc
    ? "/api/ufc-sniper-feed"
    : "/api/sniper-feed";
  const feedCollection = isPinnacle ? "nba-top-shot" : collectionSlug;
  const brandLabel = isPinnacle ? "Pinnacle" : collectionObj?.shortLabel ?? "Top Shot";

  const isMobile = useMobile();
  const [data, setData] = useState<FeedResult | null>(null);
  const [mode, setMode] = useState<"deals" | "offers">("deals");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [paused, setPaused] = useState(false);

  const [ownerKey, setOwnerKey] = useState<string | null>(null);
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
  const [ownedFilter, setOwnedFilter] = useState<"all" | "owned" | "not-owned">("all");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [editionStats, setEditionStats] = useState<Map<string, { owned: number; locked: number }>>(new Map());
  const [showFilters, setShowFilters] = useState(false);

  // ── Task 10: Tab visibility pause/resume
  const [tabHidden, setTabHidden] = useState(false);
  const [resumedIndicator, setResumedIndicator] = useState(false);

  // ── Task 7: Listing suggestions panel
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState<Array<{ player: string; serial: number; pctAbove: number }>>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);

  // ── Task 1: "Just Sold" ghost listings ──────────────────────────────────────
  const prevDealIdsRef = useRef<Set<string>>(new Set());
  const [soldIds, setSoldIds] = useState<Set<string>>(new Set());
  const [soldDeals, setSoldDeals] = useState<Map<string, SniperDeal>>(new Map());

  // ── Task 2: Edition depth panel ─────────────────────────────────────────────
  const [expandedEditionKey, setExpandedEditionKey] = useState<string | null>(null);
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<SniperDeal | null>(null);
  const [depthDeals, setDepthDeals] = useState<SniperDeal[]>([]);
  const [depthLoading, setDepthLoading] = useState(false);
  const [depthFloor, setDepthFloor] = useState<{
    topShotFloor: number | null; topShotListingCount: number;
    flowtyFloor: number | null; flowtyListingCount: number;
    crossMarketFloor: number | null; crossMarketSource: string | null;
    livetokenFmv: number | null;
  } | null>(null);
  const [depthFloorError, setDepthFloorError] = useState<string | null>(null);

  // ── Task 5: Save search ─────────────────────────────────────────────────────
  const [saveSearchMsg, setSaveSearchMsg] = useState<string | null>(null);

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
  const fetchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasMountedRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Auto-load owned editions (setID:playID) from rpc_owner_key in localStorage
  // on mount. No FCL wallet connection required: the collection page resolves
  // username → 0x address and writes it to rpc_owner_key, then this effect
  // hydrates ownedIds (now containing edition keys) from /api/owned-flow-ids.
  //
  // ownedIds is a Set<string> of edition keys ("218:8238"), not flowIds.
  // A deal matches when deal.editionKey is in the set.
  useEffect(() => {
    const TEN_MINUTES_MS = 10 * 60 * 1000;
    (async () => {
      try {
        const key = getOwnerKey();
        if (!key) {
          setOwnedIds(new Set());
          return;
        }
        setOwnerKey(key);

        // Username can't be used directly — depend on collection page /
        // WalletPreloader to resolve and rewrite rpc_owner_key as 0x.
        if (!key.startsWith("0x")) {
          setOwnedIds(new Set());
          return;
        }

        // 1. localStorage cache check (fresh < 10 min, must contain editions)
        const cachedRaw = localStorage.getItem(`rpc_owned_${key}`);
        if (cachedRaw) {
          try {
            const parsed = JSON.parse(cachedRaw) as {
              ids?: string[];
              editions?: string[];
              cachedAt?: number;
            };
            if (
              parsed &&
              Array.isArray(parsed.editions) &&
              typeof parsed.cachedAt === "number" &&
              Date.now() - parsed.cachedAt < TEN_MINUTES_MS
            ) {
              setOwnedIds(new Set(parsed.editions.map(String)));
              return;
            }
            // Anything missing `editions` (e.g. old shape with only `ids`)
            // is considered stale — fall through to refetch.
          } catch {
            // bad cache — ignore and refetch
          }
        }

        // 2. Fetch fresh from endpoint
        const res = await fetch(`/api/owned-flow-ids?wallet=${encodeURIComponent(key)}`, {
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) return;
        const json = await res.json();
        const ids: string[] = Array.isArray(json?.ids) ? json.ids.map((x: unknown) => String(x)) : [];
        const editions: string[] = Array.isArray(json?.editions)
          ? json.editions.map((x: unknown) => String(x))
          : [];

        localStorage.setItem(
          `rpc_owned_${key}`,
          JSON.stringify({ ids, editions, cachedAt: Date.now() })
        );
        setOwnedIds(new Set(editions));
      } catch {
        // Silent — empty ownedIds is the safe fallback
      }
    })();
  }, []);

  const buildFeedUrl = useCallback(() => {
    const params = new URLSearchParams();
    if (!isPinnacle) params.set("collection", feedCollection);
    if (tierTab !== "all") params.set("tier", tierTab);
    if (minDiscount > 0) params.set("minDiscount", String(minDiscount));
    if (maxPrice > 0) params.set("maxPrice", String(maxPrice));
    if (playerFilter) params.set("player", playerFilter);
    if (serialFilter !== "all") params.set("serial", serialFilter);
    if (badgeOnly) params.set("badgeOnly", "true");
    if (flowWalletOnly) params.set("flowWalletOnly", "true");
    params.set("sortBy", sortBy);
    return `${feedEndpoint}?${params}`;
  }, [tierTab, minDiscount, maxPrice, playerFilter, serialFilter, badgeOnly, flowWalletOnly, sortBy, feedEndpoint, feedCollection, isPinnacle]);

  const fetchFeed = useCallback(async () => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      setLoading(true);
      const res = await fetch(buildFeedUrl(), { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: FeedResult = await res.json();

      // ── Task 1: detect sold/delisted deals ──────────────────────────────
      const newIds = new Set(json.deals.map((d) => d.flowId));
      if (prevDealIdsRef.current.size > 0) {
        const justSold: string[] = [];
        prevDealIdsRef.current.forEach((id) => {
          if (!newIds.has(id)) justSold.push(id);
        });
        if (justSold.length > 0) {
          const prevDeals = data?.deals ?? [];
          const soldMap = new Map(soldDeals);
          for (const id of justSold) {
            const deal = prevDeals.find((d) => d.flowId === id);
            if (deal) soldMap.set(id, deal);
          }
          setSoldDeals(soldMap);
          setSoldIds((prev) => {
            const next = new Set(prev);
            justSold.forEach((id) => next.add(id));
            return next;
          });
          setTimeout(() => {
            setSoldIds((prev) => {
              const next = new Set(prev);
              justSold.forEach((id) => next.delete(id));
              return next;
            });
            setSoldDeals((prev) => {
              const next = new Map(prev);
              justSold.forEach((id) => next.delete(id));
              return next;
            });
          }, 8000);
        }
      }
      prevDealIdsRef.current = newIds;

      setData(json);
      setError(null);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(String(e));
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildFeedUrl]);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      fetchFeed();
      setCountdown(REFRESH_INTERVAL);
    } else {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
      fetchDebounceRef.current = setTimeout(() => {
        fetchFeed();
        setCountdown(REFRESH_INTERVAL);
      }, 400);
    }
    return () => {
      if (fetchDebounceRef.current) clearTimeout(fetchDebounceRef.current);
    };
  }, [fetchFeed]);

  useEffect(() => {
    if (paused || tabHidden) return;
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { fetchFeed(); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current!);
  }, [paused, tabHidden, fetchFeed]);

  // ── Task 10: Page Visibility API — pause polling when tab hidden
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden) {
        setTabHidden(true);
      } else {
        setTabHidden(false);
        setResumedIndicator(true);
        fetchFeed();
        setCountdown(REFRESH_INTERVAL);
        setTimeout(() => setResumedIndicator(false), 2000);
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [fetchFeed]);

  // ── Task 2: Edition depth panel — Escape key handler ─────────────────────
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setExpandedEditionKey(null);
        setExpandedFlowId(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  async function toggleEditionDepth(deal: SniperDeal) {
    if (expandedFlowId === deal.flowId) {
      setExpandedEditionKey(null);
      setExpandedFlowId(null);
      return;
    }
    setExpandedFlowId(deal.flowId);
    setExpandedEditionKey(deal.editionKey);
    setDepthLoading(true);
    setDepthDeals([]);
    setDepthFloor(null);
    setDepthFloorError(null);

    // Fetch edition floor data and other listings in parallel
    const floorPromise = deal.editionKey
      ? fetch(`/api/edition-floor?editionKey=${encodeURIComponent(deal.editionKey)}`, { cache: "no-store" })
          .then(async (res) => {
            if (!res.ok) throw new Error("Floor fetch failed");
            return res.json();
          })
          .then((json) => setDepthFloor(json))
          .catch(() => setDepthFloorError("Could not load floor data"))
      : Promise.resolve(setDepthFloorError("No edition data available"));

    const listingsPromise = fetch(`${feedEndpoint}?collection=${feedCollection}&editionKey=${encodeURIComponent(deal.editionKey)}&limit=20`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const json = await res.json();
        const groupKey = `${deal.playerName}|${deal.setName}|${deal.seriesName}|${deal.parallelId}`;
        setDepthDeals(
          (json.deals ?? []).filter(
            (d: SniperDeal) =>
              d.flowId !== deal.flowId &&
              `${d.playerName}|${d.setName}|${d.seriesName}|${d.parallelId}` === groupKey
          )
        );
      })
      .catch(() => {});

    try { await Promise.all([floorPromise, listingsPromise]); } catch {}
    setDepthLoading(false);
  }

  // ── Task 5: Save search handler ────────────────────────────────────────────
  async function handleSaveSearch() {
    setSaveSearchMsg(null);
    try {
      const res = await fetch("/api/watchlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "search",
          player: playerFilter || null,
          tier: tierTab !== "all" ? tierTab : null,
          maxPrice: maxPrice || null,
          minDiscount: minDiscount || null,
        }),
      });
      if (res.ok) {
        setSaveSearchMsg("Saved!");
        setTimeout(() => setSaveSearchMsg(null), 3000);
      } else {
        setSaveSearchMsg("Sign in to save searches");
        setTimeout(() => setSaveSearchMsg(null), 3000);
      }
    } catch {
      setSaveSearchMsg("Sign in to save searches");
      setTimeout(() => setSaveSearchMsg(null), 3000);
    }
  }

  const ownedCountByEdition = useMemo(() => {
    const m = new Map<string, number>();
    for (const deal of data?.deals ?? []) {
      const matched =
        (deal.intEditionKey && ownedIds.has(deal.intEditionKey)) ||
        (deal.editionKey && ownedIds.has(deal.editionKey));
      if (matched) {
        const key = deal.intEditionKey || deal.editionKey;
        m.set(key, (m.get(key) ?? 0) + 1);
      }
    }
    return m;
  }, [data?.deals, ownedIds]);

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
    const dOwned =
      (!!d.intEditionKey && ownedIds.has(d.intEditionKey)) ||
      (!!d.editionKey && ownedIds.has(d.editionKey));
    if (ownedFilter === "owned" && !dOwned) return false;
    if (ownedFilter === "not-owned" && dOwned) return false;
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
    <div className="rpc-binder-bg" style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)", overflowX: "hidden" }}>
      {/* ── Header ── */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-black)", padding: "16px", width: "100%", boxSizing: "border-box", overflowX: "hidden" }}>
        <div style={{ maxWidth: "var(--max-width)", margin: "0 auto" }}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h1 className="rpc-heading flex items-center gap-2" style={{ fontSize: "var(--text-xl)" }}>
                <span style={{ fontSize: "var(--text-2xl)" }}>⚡</span> SNIPER
              </h1>
              <p className="rpc-label" style={{ marginTop: 2 }}>
                {isPinnacle
                  ? "LIVE PINNACLE DEALS BELOW FMV — VARIANT-AWARE, FLOWTY-ONLY"
                  : "LIVE DEALS BELOW ADJUSTED FMV — BADGE-AWARE, SERIAL-ADJUSTED"}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                {!isPinnacle && (
                <span className={`rpc-chip ${stats.tsCached ? "text-amber-400 border-amber-500/30 bg-amber-500/10" : ""}`} style={stats.tsLive
                  ? { background: "rgba(52,211,153,0.08)", borderColor: "rgba(52,211,153,0.3)", color: "var(--rpc-success)" }
                  : stats.tsCached
                  ? {}
                  : { background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.2)", color: "var(--rpc-danger)" }
                }>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${stats.tsLive ? "bg-emerald-400 animate-pulse" : stats.tsCached ? "bg-amber-400 animate-pulse" : "bg-red-400/50"}`} style={{ marginRight: 4 }} />
                  {isAllDay ? "AD" : "TS"} {stats.tsLive ? `(${data?.tsCount})` : stats.tsCached ? "CACHED" : "OFFLINE"}
                </span>
                )}
                <span className="rpc-chip" style={stats.flowtyLive
                  ? { background: "rgba(59,130,246,0.08)", borderColor: "rgba(59,130,246,0.3)", color: "var(--rpc-info)" }
                  : { background: "rgba(248,113,113,0.08)", borderColor: "rgba(248,113,113,0.2)", color: "var(--rpc-danger)" }
                }>
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${stats.flowtyLive ? "bg-blue-400 animate-pulse" : "bg-red-400/50"}`} style={{ marginRight: 4 }} />
                  FLOWTY {stats.flowtyLive ? `(${data?.flowtyCount})` : "OFFLINE"}
                </span>
              </div>
              {/* Task 10: Resumed indicator */}
              {resumedIndicator && (
                <span className="rpc-chip" style={{ background: "rgba(52,211,153,0.10)", borderColor: "rgba(52,211,153,0.3)", color: "var(--rpc-success)", animation: "fadeOut 2s forwards" }}>
                  Resumed
                </span>
              )}
              {tabHidden && (
                <span className="rpc-chip" style={{ background: "rgba(234,179,8,0.10)", borderColor: "rgba(234,179,8,0.3)", color: "#fbbf24" }}>
                  Paused — tab hidden
                </span>
              )}
              <button
                onClick={() => setPaused((p) => !p)}
                className="rpc-chip"
              >
                {paused ? "▶ RESUME" : `⏸ ${countdown}s`}
              </button>
              {/* Task 7: Listing Suggestions button */}
              <button
                onClick={() => {
                  setShowSuggestions((v) => !v);
                  if (!showSuggestions && ownerKey) {
                    setSuggestionsLoading(true);
                    fetch(`/api/collection-snapshot?wallet=${encodeURIComponent(ownerKey)}`)
                      .then((r) => r.ok ? r.json() : null)
                      .then((snapshot) => {
                        if (!snapshot?.topMoments || !data?.deals) { setSuggestionsLoading(false); return; }
                        const userMoments = snapshot.topMoments ?? [];
                        const dealMap = new Map<string, SniperDeal>();
                        for (const d of data.deals) { dealMap.set(d.editionKey, d); }
                        const results: Array<{ player: string; serial: number; pctAbove: number }> = [];
                        for (const m of userMoments) {
                          const edKey = m.editionKey ?? "";
                          const deal = dealMap.get(edKey);
                          if (deal && m.fmv && deal.askPrice > m.fmv) {
                            results.push({
                              player: m.playerName ?? "Unknown",
                              serial: m.serialNumber ?? 0,
                              pctAbove: Math.round(((deal.askPrice - m.fmv) / m.fmv) * 100),
                            });
                          }
                        }
                        results.sort((a, b) => b.pctAbove - a.pctAbove);
                        setSuggestions(results.slice(0, 10));
                        setSuggestionsLoading(false);
                      })
                      .catch(() => setSuggestionsLoading(false));
                  }
                }}
                className="rpc-chip"
              >
                Listing Suggestions
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
                className={`rpc-chip min-h-[44px] ${mode === m ? "active" : ""}`}
                style={mode === m ? { background: `${accent}1A`, borderColor: `${accent}66`, color: accent } : undefined}>
                {m === "deals" ? "⚡ DEALS" : "🤝 OFFERS"}
              </button>
            ))}
          </div>
          {mode === "offers" && <OffersTab />}
          {mode === "deals" && (
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
                onChange={(e) => handlePlayerChange(e.target.value)}
                style={{ width: isMobile ? "100%" : 160, background: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)", padding: "6px 12px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", outline: "none" }}
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
          )}

          {/* Tier / Variant quick tabs */}
          <div className="flex items-center gap-1 mb-4 flex-wrap">
            {(isPinnacle ? PINNACLE_VARIANT_TABS : isGolazos ? GOLAZOS_TIER_TABS : TIER_TABS).map((t) => (
              <button
                key={t}
                onClick={() => setTierTab(t as TierTab)}
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
                onClick={() => setShowFilters((v) => !v)}
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
            {!isPinnacle && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none" style={{ color: "var(--rpc-text-muted)" }}>
              <input
                type="checkbox"
                checked={badgeOnly}
                onChange={(e) => setBadgeOnly(e.target.checked)}
              />
              BADGES ONLY
            </label>
            )}
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
            {ownedIds.size > 0 && (
              <select
                value={ownedFilter}
                onChange={(e) => setOwnedFilter(e.target.value as "all" | "owned" | "not-owned")}
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
            {/* Task 5: Save Search button */}
            <button
              onClick={handleSaveSearch}
              className="rpc-chip"
              title="Save current filter state to your watchlist"
              style={{ marginLeft: "auto" }}
            >
              {saveSearchMsg ?? "💾 SAVE SEARCH"}
            </button>
          </div>
          )}
        </>)}
        </div>
      </div>

      {mode === "deals" && (<>
      {/* Stats bar */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
        <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
          <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.total}</span> deals</span>
          <span><span style={{ color: "var(--rpc-danger)", fontWeight: 600 }}>{stats.hot}</span> hot (40%+)</span>
          {!isPinnacle && stats.badge > 0 && (
            <span><span style={{ color: "var(--tier-legendary)", fontWeight: 600 }}>{stats.badge}</span> badged</span>
          )}
          {stats.special > 0 && (
            <span><span style={{ color: "#c084fc", fontWeight: 600 }}>{stats.special}</span> special serials</span>
          )}
          <span>avg <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{fmt(stats.avgDiscount, 1)}%</span> off</span>
          {ownedIds.size > 0 && (
            <span style={{ color: "var(--rpc-text-ghost)" }}>{ownedIds.size} owned editions tracked</span>
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
      <div style={{ maxWidth: "100vw", margin: "0 auto", padding: "16px" }}>
        {isPinnacle && (
          <div
            className="rpc-hud"
            style={{
              marginBottom: 12,
              padding: "10px 14px",
              borderColor: "rgba(168,85,247,0.4)",
              color: "var(--rpc-text-secondary)",
              fontSize: "var(--text-sm)",
              fontFamily: "var(--font-mono)",
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <span style={{ color: "#c084fc", fontWeight: 600 }}>ℹ</span>
            <span>
              Deals listed on the Disney Pinnacle Marketplace — purchase at{" "}
              <a
                href="https://disneypinnacle.com/marketplace"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "#c084fc", textDecoration: "underline" }}
              >
                disneypinnacle.com
              </a>
              .
            </span>
          </div>
        )}
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

        {visibleDeals.length > 0 && isMobile && (
          <div className="flex flex-col gap-2">
            {visibleDeals.map((deal) => {
              const isFlowty = (deal.source ?? "topshot") === "flowty";
              const isPinnacleDeal = deal.source === "pinnacle";
              const isOwned =
                (!!deal.intEditionKey && ownedIds.has(deal.intEditionKey)) ||
                (!!deal.editionKey && ownedIds.has(deal.editionKey));
              return (
                <div key={`m-${deal.source}-${deal.flowId}`} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("a,button")) return; setSelectedDeal(deal); }} className="rpc-card p-3 flex flex-col gap-1.5 cursor-pointer">
                  {/* Row 1: Player + Tier + Source */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)" }} className="truncate">{deal.playerName}</span>
                      {isPinnacle ? (
                        <span style={{ color: variantColor(deal.tier), fontWeight: 600, fontSize: "var(--text-xs)", border: `1px solid ${variantColor(deal.tier)}40`, background: `${variantColor(deal.tier)}15`, borderRadius: 3, padding: "0 4px" }}>
                          {deal.tier}
                        </span>
                      ) : (
                        <span style={{ color: tierColor(deal.tier), fontWeight: 600, fontSize: "var(--text-xs)" }}>
                          {deal.tier.charAt(0) + deal.tier.slice(1).toLowerCase()}
                        </span>
                      )}
                    </div>
                    <SourceBadge source={deal.source} isAllDay={isAllDay} />
                  </div>
                  {/* Row 2: Set name + franchise */}
                  <div className="text-xs" style={{ color: "var(--rpc-text-muted)" }}>{deal.setName}{deal.seriesName ? ` · ${deal.seriesName}` : ""}{isPinnacle && deal.teamName ? ` · ${deal.teamName}` : ""}</div>
                  {/* Row 3: Serial + Ask + Discount */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)", fontSize: "var(--text-sm)" }}>#{deal.serial}</span>
                      {isOwned && <span style={{ color: "var(--rpc-success)", fontSize: 10 }}>✓</span>}
                      <SerialBadge deal={deal} />
                      {deal.isJersey && (
                        <span className="rpc-chip" style={{ background: "rgba(20,184,166,0.15)", borderColor: "rgba(20,184,166,0.3)", color: "#5eead4", fontSize: 9, padding: "1px 5px" }}>Jersey</span>
                      )}
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>${fmt(deal.askPrice)}</span>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-bold ${discountColor(deal.discount)}`} style={{ fontFamily: "var(--font-mono)" }}>
                      {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                    </span>
                  </div>
                  {/* Row 4: Adj. FMV + Action */}
                  <div className="flex items-center justify-between gap-2">
                    <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)" }}>Adj. FMV ${fmt(deal.adjustedFmv)}</span>
                    {!isPinnacle && deal.hasBadge && deal.badgeSlugs.length > 0 && (
                      <div className="flex gap-1 flex-wrap items-center">
                        {Array.from(new Set(deal.badgeSlugs)).slice(0, 3).map((slug) => (
                          <BadgeIcon key={slug} slug={slug} />
                        ))}
                      </div>
                    )}
                    <a
                      href={deal.buyUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => { e.stopPropagation(); trackClick(deal, null); }}
                      className={isFlowty || isPinnacleDeal ? "rpc-chip" : "rpc-btn-ghost"}
                      style={isPinnacleDeal
                        ? { background: "rgba(168,85,247,0.15)", borderColor: "rgba(168,85,247,0.4)", color: "#c084fc", textDecoration: "none", padding: "4px 10px", fontSize: "var(--text-xs)" }
                        : isFlowty
                        ? { background: "rgba(59,130,246,0.15)", borderColor: "rgba(59,130,246,0.4)", color: "var(--rpc-info)", textDecoration: "none", padding: "4px 10px", fontSize: "var(--text-xs)" }
                        : { padding: "4px 10px", textDecoration: "none", borderColor: `${accent}40`, color: accent, fontSize: "var(--text-xs)" }
                      }
                    >
                      {isPinnacleDeal ? "BUY ON PINNACLE →" : isFlowty ? "FLOWTY →" : "BUY →"}
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {visibleDeals.length > 0 && !isMobile && (
          <div className="rpc-card" style={{ overflow: "auto", borderRadius: "var(--radius-md)", maxWidth: "100%" }}>
            <table style={{ width: "100%", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)", borderCollapse: "collapse" }}>
              <thead>
                <tr className="rpc-thead-scanline" style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
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
                {/* Task 1: Render sold ghost deals */}
                {Array.from(soldIds).map((soldId) => {
                  const deal = soldDeals.get(soldId);
                  if (!deal) return null;
                  return (
                    <tr
                      key={`sold-${soldId}`}
                      style={{ borderBottom: "1px solid var(--rpc-border)", opacity: 0.4, textDecoration: "line-through", pointerEvents: "none" }}
                    >
                      <td style={{ padding: "8px 12px" }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <div style={{ width: 36, height: 36, borderRadius: 4, background: "var(--rpc-surface-raised)", flexShrink: 0 }} />
                          <div>
                            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>{deal.playerName}</div>
                            <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{deal.setName}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)" }}>#{deal.serial}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{timeAgo(deal.updatedAt)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>—</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)" }}>${fmt(deal.askPrice)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)" }}>${fmt(deal.adjustedFmv)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/30 text-red-300 border border-red-500/50" style={{ fontFamily: "var(--font-mono)" }}>SOLD</span>
                      </td>
                      <td />
                      <td />
                    </tr>
                  );
                })}
                {visibleDeals.map((deal) => (
                  <React.Fragment key={`${deal.source}-${deal.flowId}-${deal.listingResourceID}`}>
                  <tr
                    className={`${holoClass(deal.tier)}${deal.flowId === highlightedId ? " ring-2" : ""}${deal.discount >= 40 ? " rpc-hot-deal" : ""}`}
                    style={{ borderBottom: expandedFlowId === deal.flowId ? "none" : "1px solid var(--rpc-border)", transition: "background var(--transition-fast)", cursor: "pointer", ...(deal.flowId === highlightedId ? { boxShadow: `0 0 0 2px ${accent}80`, background: `${accent}12` } : {}) }}
                    onClick={() => toggleEditionDepth(deal)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--rpc-surface-hover)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = deal.discount >= 40 ? "rgba(224,58,47,0.08)" : "transparent"; }}
                  >
                    {/* Moment info */}
                    <td style={{ padding: "8px 12px" }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                        {deal.thumbnailUrl ? (
                          <SniperThumbnailPreview thumbUrl={deal.thumbnailUrl} playerName={deal.playerName} tierColor={tierColor(deal.tier)}>
                            <img
                              src={deal.thumbnailUrl}
                              alt={deal.playerName}
                              style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 4, flexShrink: 0, background: "#1a1a1a", cursor: "pointer" }}
                              loading="lazy"
                              onClick={(e) => { e.stopPropagation(); setSelectedDeal(deal); }}
                              onError={(e) => {
                                const img = e.currentTarget as HTMLImageElement;
                                img.onerror = null;
                                img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                              }}
                            />
                          </SniperThumbnailPreview>
                        ) : (
                          <div style={{ width: 36, height: 36, borderRadius: 4, background: "var(--rpc-surface-raised)", flexShrink: 0 }} />
                        )}
                        <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", lineHeight: 1.2 }}>{deal.playerName}</div>
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap" style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)" }}>
                        {isPinnacle ? (
                          <span
                            style={{
                              color: variantColor(deal.tier),
                              fontWeight: 600,
                              border: `1px solid ${variantColor(deal.tier)}40`,
                              background: `${variantColor(deal.tier)}15`,
                              borderRadius: 3,
                              padding: "0 4px",
                            }}
                          >
                            {deal.tier}
                          </span>
                        ) : (
                          <span className={deal.tier.toUpperCase() === "LEGENDARY" ? "rpc-tier-glow-legendary" : deal.tier.toUpperCase() === "ULTIMATE" ? "rpc-tier-glow-ultimate" : deal.tier.toUpperCase() === "RARE" ? "rpc-tier-glow-rare" : ""} style={{ color: tierColor(deal.tier), fontWeight: 600 }}>
                            {deal.tier.charAt(0) + deal.tier.slice(1).toLowerCase()}
                          </span>
                        )}
                        <span style={{ color: "var(--rpc-text-ghost)" }}>·</span>
                        <span style={{ color: "var(--rpc-text-muted)" }}>{deal.setName}</span>
                        {!isPinnacle && deal.parallel && deal.parallel !== "Base" && (
                          <span
                            style={{
                              color: "#c084fc",
                              fontWeight: 600,
                              border: "1px solid rgba(192,132,252,0.4)",
                              background: "rgba(192,132,252,0.10)",
                              borderRadius: 3,
                              padding: "0 4px",
                            }}
                          >
                            {deal.parallel}
                          </span>
                        )}
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
                      {(ownedCountByEdition.get(deal.editionKey || deal.momentId) ?? 0) > 0 && (
                        <div className="mt-1">
                          <span
                            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5"
                            style={{
                              fontSize: "var(--text-xs)",
                              fontFamily: "var(--font-mono)",
                              fontWeight: 600,
                              background: "rgba(0,232,130,0.12)",
                              border: "1px solid rgba(0,232,130,0.40)",
                              color: "#00e882",
                            }}
                          >
                            You own {ownedCountByEdition.get(deal.editionKey || deal.momentId)}
                          </span>
                        </div>
                      )}
                      {!isPinnacle && deal.hasBadge && deal.badgeSlugs.length > 0 && (
                        <BadgePills slugs={deal.badgeSlugs} />
                      )}
                      {/* Task 4: Pack-linked listing tag */}
                      {!isPinnacle && deal.packName && (
                        <div className="flex gap-1 mt-1">
                          <span
                            className="px-1 py-0.5 rounded text-xs border bg-amber-500/10 text-amber-300 border-amber-500/25"
                            title={`${deal.packName}${deal.packEvRatio != null ? ` · EV ratio: ${deal.packEvRatio.toFixed(2)}x` : ""}`}
                          >
                            📦 Pack
                          </span>
                        </div>
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
                        </div>
                      </div>
                    </td>

                    {/* Serial — Task 3: serial intelligence chips */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      <div style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)" }}>#{deal.serial}</div>
                      {deal.circulationCount > 0 && (
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>/ {deal.circulationCount.toLocaleString()}</div>
                      )}
                      <div className="flex gap-1 mt-0.5 flex-wrap justify-end">
                        {deal.isLowestAsk && (
                          <span className="rpc-chip" title="Lowest ask for this edition" style={{ background: "rgba(16,185,129,0.15)", borderColor: "rgba(16,185,129,0.3)", color: "#34d399", fontSize: 9, padding: "1px 5px" }}>
                            Floor
                          </span>
                        )}
                        {deal.isJersey && (
                          <span className="rpc-chip" title="Jersey match" style={{ background: "rgba(20,184,166,0.15)", borderColor: "rgba(20,184,166,0.3)", color: "#5eead4", fontSize: 9, padding: "1px 5px" }}>
                            🏀 Jersey
                          </span>
                        )}
                        {deal.serial <= 10 && (
                          <span className="rpc-chip" style={{ background: "rgba(234,179,8,0.15)", borderColor: "rgba(234,179,8,0.3)", color: "#fde047", fontSize: 9, padding: "1px 5px" }}>
                            LOW POP
                          </span>
                        )}
                        {deal.serial > 10 && String(deal.serial).endsWith("00") && (
                          <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.12)", borderColor: "rgba(168,85,247,0.25)", color: "#c084fc", fontSize: 9, padding: "1px 5px" }}>
                            ROUND
                          </span>
                        )}
                        {deal.serialSignal && !deal.isJersey && deal.serial > 10 && (
                          <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.12)", borderColor: "rgba(168,85,247,0.25)", color: "#c084fc", fontSize: 9, padding: "1px 5px" }}>
                            {deal.serialSignal}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Listed */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
                      {timeAgo(deal.updatedAt)}
                    </td>

                    {/* Own / Lock */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
                      {(() => {
                        if (ownedIds.size === 0) return "—";
                        // Use edition-level stats (editionKey match) for accurate own/lock counts
                        const eStats = editionStats.get(deal.editionKey);
                        if (eStats && eStats.owned > 0) {
                          return (
                            <span style={{ color: "var(--rpc-success)" }}>
                              {eStats.owned}{eStats.locked > 0 ? ` / ${eStats.locked}🔒` : ""}
                            </span>
                          );
                        }
                        // ownedIds is a set of integer setID:playID keys from on-chain.
                        const isOwned =
                          (!!deal.intEditionKey && ownedIds.has(deal.intEditionKey)) ||
                          (!!deal.editionKey && ownedIds.has(deal.editionKey));
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
                    <td style={{ padding: "8px 12px" }} onClick={(e) => e.stopPropagation()}>
                      <ActionCell
                        deal={deal}
                        ownedIds={ownedIds}
                        accent={accent}
                        offerMode={offerMode}
                        offerDurationDays={offerDurationDays}
                      />
                    </td>
                  </tr>
                  {/* Task 2: Edition depth panel */}
                  {expandedFlowId === deal.flowId && (
                    <tr style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
                      <td colSpan={9} style={{ padding: "8px 16px" }}>
                        {depthLoading ? (
                          <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", padding: "8px 0" }}>Loading other listings…</div>
                        ) : (
                          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {/* Cross-market floor data */}
                            {depthFloorError ? (
                              <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", padding: "4px 0" }}>{depthFloorError}</div>
                            ) : depthFloor ? (
                              <div className="flex flex-wrap items-center gap-3" style={{ padding: "6px 0" }}>
                                <div className="rpc-chip" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                  <span style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.08em" }}>TOP SHOT</span>
                                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-primary)", fontWeight: 600 }}>
                                    {depthFloor.topShotFloor != null ? `$${fmt(depthFloor.topShotFloor)}` : "—"}
                                  </span>
                                  <span style={{ fontSize: 9, color: "var(--rpc-text-ghost)" }}>({depthFloor.topShotListingCount} listed)</span>
                                </div>
                                <div className="rpc-chip" style={{ display: "flex", alignItems: "center", gap: 6, borderColor: "rgba(59,130,246,0.3)" }}>
                                  <span style={{ fontSize: 9, color: "var(--rpc-info)", letterSpacing: "0.08em" }}>FLOWTY</span>
                                  <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-primary)", fontWeight: 600 }}>
                                    {depthFloor.flowtyFloor != null ? `$${fmt(depthFloor.flowtyFloor)}` : "—"}
                                  </span>
                                  <span style={{ fontSize: 9, color: "var(--rpc-text-ghost)" }}>({depthFloor.flowtyListingCount} listed)</span>
                                </div>
                                {depthFloor.crossMarketFloor != null && (
                                  <div className="rpc-chip" style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(74,222,128,0.08)", borderColor: "rgba(74,222,128,0.3)" }}>
                                    <span style={{ fontSize: 9, color: "var(--rpc-success)", letterSpacing: "0.08em" }}>BEST FLOOR</span>
                                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-success)", fontWeight: 700 }}>
                                      ${fmt(depthFloor.crossMarketFloor)}
                                    </span>
                                    <span style={{ fontSize: 9, color: "var(--rpc-text-ghost)" }}>on {depthFloor.crossMarketSource === "flowty" ? "Flowty" : "TopShot"}</span>
                                  </div>
                                )}
                                {depthFloor.livetokenFmv != null && (
                                  <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
                                    LT FMV: ${fmt(depthFloor.livetokenFmv)}
                                  </span>
                                )}
                              </div>
                            ) : null}

                            {/* Other listings */}
                            {depthDeals.length === 0 ? (
                              <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", padding: "4px 0" }}>No other listings for this edition.</div>
                            ) : (
                              <>
                                <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-ghost)", letterSpacing: "0.1em" }}>
                                  {depthDeals.length} OTHER LISTING{depthDeals.length !== 1 ? "S" : ""} FOR {deal.playerName} — {deal.setName}
                                </div>
                                {[...depthDeals].sort((a, b) => a.askPrice - b.askPrice).map((dd) => (
                                  <div key={dd.flowId} className="flex items-center gap-4" style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", padding: "4px 0" }}>
                                    <span style={{ color: "var(--rpc-text-secondary)", minWidth: 60 }}>#{dd.serial}</span>
                                    <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600, minWidth: 70 }}>${fmt(dd.askPrice)}</span>
                                    <span style={{ color: dd.discount >= 15 ? "var(--rpc-success)" : "var(--rpc-text-muted)", minWidth: 60 }}>
                                      {dd.discount > 0 ? `-${fmt(dd.discount, 1)}%` : "~0%"}
                                    </span>
                                    <span style={{ color: "var(--rpc-text-ghost)", minWidth: 50 }}>{dd.source === "flowty" ? "Flowty" : "TS"}</span>
                                    <span style={{ color: "var(--rpc-text-ghost)", minWidth: 60 }}>{timeAgo(dd.updatedAt)}</span>
                                    <a href={dd.buyUrl} target="_blank" rel="noopener noreferrer" style={{ color: accent, textDecoration: "none" }}>BUY →</a>
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
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

      {/* Task 7: Listing Suggestions slide-in panel */}
      {showSuggestions && (
        <div style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: 340,
          background: "var(--rpc-bg, #080808)", borderLeft: "1px solid var(--rpc-border)",
          zIndex: 200, overflowY: "auto", padding: 20,
          boxShadow: "-4px 0 20px rgba(0,0,0,0.5)",
        }}>
          <div className="flex items-center justify-between mb-4">
            <span className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>Listing Suggestions</span>
            <button onClick={() => setShowSuggestions(false)} className="rpc-chip" style={{ padding: "4px 10px" }}>✕</button>
          </div>
          {!ownerKey ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
              Load your wallet to see listing suggestions
            </div>
          ) : suggestionsLoading ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
              Analyzing your portfolio...
            </div>
          ) : suggestions.length === 0 ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
              No listing suggestions found. Your moments are priced at or below current market asks.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {suggestions.map((s, i) => (
                <div key={i} style={{
                  background: "var(--rpc-surface, rgba(255,255,255,0.03))",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: 8, padding: 12,
                }}>
                  <div className="rpc-mono" style={{ fontSize: "var(--text-sm)", color: "var(--rpc-text-primary)" }}>
                    Consider listing: <strong>{s.player}</strong> serial #{s.serial}
                  </div>
                  <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-success)", marginTop: 4 }}>
                    Current asks are {s.pctAbove}% above your FMV
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <MomentDetailModal
        moment={selectedDeal ? {
          flowId: selectedDeal.flowId,
          playerName: selectedDeal.playerName,
          setName: selectedDeal.setName,
          tier: selectedDeal.tier,
          serialNumber: selectedDeal.serial,
          mintSize: selectedDeal.circulationCount,
          fmv: selectedDeal.adjustedFmv,
          dealRating: selectedDeal.dealRating ?? (selectedDeal.discount > 0 ? Math.min(1, selectedDeal.discount / 50) : null),
          listingPrice: selectedDeal.askPrice,
          marketConfidence: selectedDeal.confidence ?? null,
          badgeTitles: selectedDeal.badgeLabels ?? [],
          officialBadges: [],
          imageUrlPrefix: null,
          buyUrl: selectedDeal.buyUrl,
        } : null}
        onClose={() => setSelectedDeal(null)}
      />
    </div>
  );
}