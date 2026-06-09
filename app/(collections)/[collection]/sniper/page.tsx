"use client";
import React from "react";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useWarmCache } from "@/lib/warmup/WarmupContext";
import { getCollection, marketplaceMomentUrl, dapperMarketMomentUrl } from "@/lib/collections";
import { getOwnerKey } from "@/lib/owner-key";
import { PINNACLE_VARIANT_COLORS, PINNACLE_VARIANT_LABELS } from "@/lib/pinnacle/pinnacleTypes";
import { slugifyName } from "@/lib/entity-labels";
import MomentDetailModal from "@/components/MomentDetailModal";
import BadgeIcon from "@/components/BadgeIcon";
import LeagueFilter, { type LeagueValue } from "@/components/filters/LeagueFilter";
import { track } from "@/lib/telemetry/track";
import { trackOutboundClick } from "@/lib/track-click";

function SniperThumbnailPreview({ thumbUrl, playerName, tierColor, backgroundColor, children }: { thumbUrl: string | null; playerName: string; tierColor: string; backgroundColor?: string; children: React.ReactNode }) {
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
    <div ref={ref} onMouseEnter={onEnter} onMouseLeave={() => setHovered(false)} style={{ display: "inline-block", backgroundColor, borderRadius: backgroundColor ? 4 : undefined }}>
      {children}
      {hovered && previewUrl && pos && (
        <div style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 500, pointerEvents: "none", background: "#000", border: `2px solid ${tierColor}`, borderRadius: 6, padding: 6, boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
          <img src={previewUrl} alt={playerName} width={200} height={200} style={{ width: 200, height: 200, objectFit: "contain", display: "block" }} />
          <div style={{ color: "#fff", fontSize: 11, marginTop: 4, textAlign: "center", fontFamily: "var(--font-display)", fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>{playerName}</div>
        </div>
      )}
    </div>
  );
}

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
  source?: "topshot" | "allday" | "golazos" | "pinnacle" | "flowty";
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
  trackOutboundClick({
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
  });
}

// Resolve the outbound marketplace URL for a deal. Prefer the deal's own
// listing URL when it points at a live native marketplace; Flowty links are
// dead, so fall back to the collection's native moment page.
function resolveViewUrl(deal: SniperDeal, collectionSlug: string): string | null {
  const url = deal.buyUrl?.trim();
  if (url && !url.includes("flowty.io")) return url;
  return marketplaceMomentUrl(collectionSlug, deal.momentId);
}

// Second-marketplace (dapper.market) link rendered alongside the native one.
// dapper deep-links need a REAL on-chain moment id, not an edition key — so we
// return null (skip the link) for edition-level deals rather than mint a wrong
// one. TopShot real listings carry the moment id in momentId (plain integer);
// the TS edition-level RPC augment puts a setID:playID key there. AllDay carries
// the edition id in momentId and the real moment id in flowId, but only when the
// two differ (edition-level AllDay deals set flowId === momentId).
function resolveDapperUrl(deal: SniperDeal, collectionSlug: string): string | null {
  let momentId: string | null = null;
  if (deal.source === "allday") {
    momentId = deal.flowId && deal.flowId !== deal.momentId ? deal.flowId : null;
  } else {
    momentId = deal.momentId && /^\d+$/.test(deal.momentId) ? deal.momentId : null;
  }
  return dapperMarketMomentUrl(collectionSlug, momentId);
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

// AllDay uses a distinct palette from Top Shot's CSS tokens — green UNCOMMON,
// blue RARE, amber LEGENDARY, purple ULTIMATE — picked for better contrast
// against AllDay's blue accent.
const ALLDAY_TIER_COLORS: Record<string, string> = {
  COMMON: "#94A3B8",
  UNCOMMON: "#22C55E",
  RARE: "#3B82F6",
  LEGENDARY: "#F59E0B",
  ULTIMATE: "#A855F7",
};

function allDayTierColor(tier: string): string {
  return ALLDAY_TIER_COLORS[tier?.toUpperCase()] ?? "#94A3B8";
}

function resolveTierColor(tier: string, isAllDay: boolean): string {
  return isAllDay ? allDayTierColor(tier) : tierColor(tier);
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

function discountColor(pct: number): React.CSSProperties {
  if (pct >= 50) return { background: "rgba(239,68,68,0.2)", color: "rgb(252,165,165)", border: "1px solid rgba(239,68,68,0.4)" };
  if (pct >= 30) return { background: "rgba(249,115,22,0.2)", color: "rgb(253,186,116)", border: "1px solid rgba(249,115,22,0.4)" };
  if (pct >= 15) return { background: "rgba(234,179,8,0.2)", color: "rgb(253,224,71)", border: "1px solid rgba(234,179,8,0.4)" };
  if (pct >= 5)  return { background: "rgba(16,185,129,0.2)", color: "rgb(110,231,183)", border: "1px solid rgba(16,185,129,0.4)" };
  return { border: "1px solid var(--rpc-border)" };
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

// Marketplace source chips — each native fetcher tags its deals with a
// per-collection slug; Flowty mirror data uses "flowty". Phase 5 expanded
// the dictionary so AllDay / Golazos native rows render their own label
// instead of falling back to "AD" or being mistagged as Flowty.
const SOURCE_BADGE_STYLES: Record<NonNullable<SniperDeal["source"]>, { bg: string; border: string; color: string; label: string }> = {
  topshot:  { bg: "var(--rpc-surface-raised)", border: "var(--rpc-border)",        color: "var(--rpc-text-muted)", label: "TS NATIVE" },
  allday:   { bg: "rgba(79,148,212,0.12)",     border: "rgba(79,148,212,0.25)",    color: "#93C5FD",                label: "ALLDAY NATIVE" },
  golazos:  { bg: "rgba(34,197,94,0.12)",      border: "rgba(34,197,94,0.25)",     color: "#86EFAC",                label: "GOLAZOS NATIVE" },
  pinnacle: { bg: "rgba(168,85,247,0.12)",     border: "rgba(168,85,247,0.25)",    color: "#c084fc",                label: "PINNACLE NATIVE" },
  flowty:   { bg: "rgba(59,130,246,0.12)",     border: "rgba(59,130,246,0.25)",    color: "var(--rpc-info)",        label: "FLOWTY" },
};

function SourceBadge({ source, isAllDay }: { source?: SniperDeal["source"]; isAllDay?: boolean }) {
  // Fall back to the legacy AD/TS chip when source is missing.
  const key: NonNullable<SniperDeal["source"]> = source ?? (isAllDay ? "allday" : "topshot");
  const style = SOURCE_BADGE_STYLES[key];
  return (
    <span className="rpc-chip" style={{ background: style.bg, borderColor: style.border, color: style.color }}>
      {style.label}
    </span>
  );
}

// BadgeIcon, BadgePills, and the slug → label / color / camelCase lookups
// that used to live here are now shared components that read from the
// badge_taxonomy RPC — imported above. Callers pass the raw slug (e.g.
// "rookie_year"); the taxonomy normalizes that to "rookieyear" and resolves
// canonical title, color_family, priority, and optional icon_url.

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
  accent,
  collectionSlug,
}: {
  deal: SniperDeal;
  accent: string;
  collectionSlug: string;
}) {
  const viewUrl = resolveViewUrl(deal, collectionSlug);
  const dapperUrl = resolveDapperUrl(deal, collectionSlug);
  if (!viewUrl && !dapperUrl) {
    return (
      <span className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
        —
      </span>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px", alignItems: "flex-end" }}>
      {viewUrl && (
        <a
          href={viewUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackClick(deal, null)}
          className="rpc-btn-ghost"
          style={{ padding: "4px 12px", textDecoration: "none", borderColor: `${accent}40`, color: accent }}
        >
          View Listing →
        </a>
      )}
      {dapperUrl && (
        <a
          href={dapperUrl}
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => trackClick(deal, null)}
          className="rpc-btn-ghost"
          style={{ padding: "4px 12px", textDecoration: "none", borderColor: `${accent}40`, color: accent }}
        >
          Dapper ↗
        </a>
      )}
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
  const accent = collectionObj?.accent ?? "var(--rpc-red)";
  const isAllDay = collectionSlug === "nfl-all-day";
  const isPinnacle = collectionSlug === "pinnacle" || collectionSlug === "disney-pinnacle";
  const isGolazos = collectionSlug === "laliga-golazos";
  const isUfc = collectionSlug === "ufc";

  // Phase 5: every collection now flows through the unified endpoint. The
  // per-collection dispatch lives server-side in /api/sniper-feed and reuses
  // the existing dedicated handlers via shared compute functions.
  const feedEndpoint = "/api/sniper-feed";
  // Pinnacle uses its own slug; the legacy fallback to "nba-top-shot" was a
  // workaround from when /api/pinnacle-sniper ignored the collection param.
  const feedCollection = isPinnacle ? "disney-pinnacle" : collectionSlug;
  const brandLabel = isPinnacle ? "Pinnacle" : collectionObj?.shortLabel ?? "Top Shot";

  const isMobile = useMobile();
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL);
  const [paused, setPaused] = useState(false);

  const [ownerKey, setOwnerKey] = useState<string | null>(null);
  const [ownedIds, setOwnedIds] = useState<Set<string>>(new Set());

  const [tierTab, setTierTab] = useState<TierTab>("all");
  const [sortBy, setSortBy] = useState<SortOption>(isAllDay ? "price_asc" : "listed_desc");
  const [minDiscount, setMinDiscount] = useState(0);
  const [maxPrice, setMaxPrice] = useState(0);
  const [leagueFilter, setLeagueFilter] = useState<LeagueValue>("all");
  const [serialFilter, setSerialFilter] = useState("all");
  const [badgeOnly, setBadgeOnly] = useState(false);
  const [flowWalletOnly, setFlowWalletOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [showVerifiedOnly, setShowVerifiedOnly] = useState(false);
  const [ownedFilter, setOwnedFilter] = useState<"all" | "owned" | "not-owned">("all");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Fast Break deep-link state (?moment= / ?momentId=). Distinct from the
  // ?highlight= flowId pattern: Fast Break passes the moment_id from
  // cached_listings, which corresponds to deal.momentId on the feed (NOT
  // deal.flowId). We resolve to flowId in a separate effect once the feed
  // loads, then drive the existing highlight/scroll machinery from there.
  const [deepLinkMomentId, setDeepLinkMomentId] = useState<string | null>(null);
  const [deepLinkDismissed, setDeepLinkDismissed] = useState(false);
  const [deepLinkResolved, setDeepLinkResolved] = useState<"pending" | "found" | "missing">("pending");
  const [editionStats, setEditionStats] = useState<Map<string, { owned: number; locked: number }>>(new Map());
  const [showFilters, setShowFilters] = useState(false);

  // Telemetry: emit a `sniper-filter-applied` beacon any time the user-facing
  // filter set changes. The track() helper itself debounces, so a flurry of
  // input clicks coalesces into one beacon per ~350ms.
  useEffect(() => {
    track("sniper-filter-applied", {
      tier: tierTab,
      sort: sortBy,
      min_discount: minDiscount,
      max_price: maxPrice,
      league: leagueFilter,
      serial: serialFilter,
      badge_only: badgeOnly,
      verified_only: showVerifiedOnly,
      owned: ownedFilter,
    });
  }, [tierTab, sortBy, minDiscount, maxPrice, leagueFilter, serialFilter, badgeOnly, showVerifiedOnly, ownedFilter]);

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

  // ── Relative deals fallback (ASK_ONLY collections) ────────────────────────
  // When the sniper feed is empty on an ASK_ONLY collection (Golazos, UFC),
  // fall back to /api/relative-deals which ranks listings against tier
  // median instead of the circular "ask vs FMV" discount.
  interface RelativeDeal {
    player_name: string | null
    set_name: string | null
    tier: string | null
    ask_price: number | string | null
    tier_median: number | string | null
    discount_pct: number | string | null
    fmv_usd: number | string | null
    confidence: string | null
    serial_number: number | null
    buy_url: string | null
  }
  interface TierBenchmark {
    count: number
    floor: number | string | null
    p25: number | string | null
    median: number | string | null
    avg: number | string | null
    p75: number | string | null
  }
  const [relativeDeals, setRelativeDeals] = useState<RelativeDeal[] | null>(null);
  const [benchmarks, setBenchmarks] = useState<Record<string, TierBenchmark> | null>(null);
  const [relativeLoading, setRelativeLoading] = useState(false);

  // Highlight detection on page load — supports two URL shapes:
  //   ?highlight={flowId}  (legacy share-link copy from this page)
  //   ?moment={momentId} or ?momentId={momentId}  (Fast Break Acquisition Gap)
  // The deal-resolve effect runs later in the component once `data` is in
  // scope and turns the deepLinkMomentId into a flowId highlight + scroll.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("highlight");
    if (id) setHighlightedId(id);
    const moment = params.get("moment") ?? params.get("momentId");
    if (moment) setDeepLinkMomentId(moment);
  }, []);

  function dismissDeepLinkBanner() {
    setDeepLinkDismissed(true);
    setDeepLinkMomentId(null);
    setHighlightedId(null);
    setDeepLinkResolved("pending");
  }

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
  const prevDataRef = useRef<FeedResult | null>(null);

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

  // Edition-level owned/locked counts for the "Edition Owned/Locked" column.
  // Reads wallet_moments_cache (the same source the Collection page uses)
  // grouped by edition_key. Populates `editionStats`, which the Own/Lock cell
  // renders as "owned / locked" (e.g. "3 / 2"). Skips Pinnacle (different
  // edition-key shape) and short-circuits when ownerKey is missing.
  useEffect(() => {
    if (isPinnacle) return;
    let cancelled = false;
    (async () => {
      try {
        const key = getOwnerKey();
        if (!key || !key.startsWith("0x")) {
          setEditionStats(new Map());
          return;
        }
        const res = await fetch(
          `/api/wallet/edition-counts?wallet=${encodeURIComponent(key)}&collection=${encodeURIComponent(collectionSlug)}`,
          { cache: "no-store", signal: AbortSignal.timeout(15000) }
        );
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { editions?: Record<string, { owned: number; locked: number }> };
        if (cancelled) return;
        const next = new Map<string, { owned: number; locked: number }>();
        for (const [k, v] of Object.entries(json.editions ?? {})) {
          next.set(k, { owned: Number(v.owned) || 0, locked: Number(v.locked) || 0 });
        }
        setEditionStats(next);
      } catch {
        // Silent — empty editionStats falls back to the simple ownedIds path.
      }
    })();
    return () => { cancelled = true };
  }, [collectionSlug, isPinnacle]);

  const buildFeedUrl = useCallback(() => {
    const params = new URLSearchParams();
    params.set("collection", feedCollection);
    if (tierTab !== "all") params.set("tier", tierTab);
    if (minDiscount > 0) params.set("minDiscount", String(minDiscount));
    if (maxPrice > 0) params.set("maxPrice", String(maxPrice));
    if (playerFilter) params.set("player", playerFilter);
    if (serialFilter !== "all") params.set("serial", serialFilter);
    if (badgeOnly) params.set("badgeOnly", "true");
    if (flowWalletOnly) params.set("flowWalletOnly", "true");
    if (collectionSlug === "nba-top-shot" && leagueFilter !== "all") params.set("league", leagueFilter);
    params.set("sortBy", sortBy);
    return `${feedEndpoint}?${params}`;
  }, [tierTab, minDiscount, maxPrice, playerFilter, serialFilter, badgeOnly, flowWalletOnly, sortBy, feedEndpoint, feedCollection, collectionSlug, leagueFilter]);

  const feedKey = buildFeedUrl();

  const feedFetcher = useCallback(async () => {
    const res = await fetch(feedKey, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as FeedResult;
  }, [feedKey]);

  const { data, loading, error: warmError, refresh } = useWarmCache<FeedResult>(
    feedKey,
    feedFetcher,
    { ttlMs: 30_000 },
  );
  const error = warmError ? String(warmError) : null;

  // ── Task 1: detect sold/delisted deals as data changes ────────────────────
  useEffect(() => {
    if (!data) return;
    const newIds = new Set(data.deals.map((d) => d.flowId));
    if (prevDealIdsRef.current.size > 0) {
      const justSold: string[] = [];
      prevDealIdsRef.current.forEach((id) => {
        if (!newIds.has(id)) justSold.push(id);
      });
      if (justSold.length > 0) {
        const prevDeals = prevDataRef.current?.deals ?? [];
        setSoldDeals((prev) => {
          const next = new Map(prev);
          for (const id of justSold) {
            const deal = prevDeals.find((d) => d.flowId === id);
            if (deal) next.set(id, deal);
          }
          return next;
        });
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
    prevDataRef.current = data;
  }, [data]);

  // ── ASK_ONLY fallback: when the feed comes back empty for Golazos or UFC
  // (whose FMV is just ask = circular), load tier-median-based deals + a
  // benchmark reference so the page isn't blank.
  useEffect(() => {
    if (!data) return;
    if (!(isGolazos || isUfc) || data.deals.length !== 0) {
      setRelativeDeals(null);
      setBenchmarks(null);
      return;
    }
    let cancelled = false;
    setRelativeLoading(true);
    (async () => {
      try {
        const [rel, bench] = await Promise.all([
          fetch(`/api/relative-deals?collection=${encodeURIComponent(collectionSlug)}&minDiscount=10&limit=50`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetch(`/api/tier-pricing-benchmarks?collection=${encodeURIComponent(collectionSlug)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (cancelled) return;
        setRelativeDeals(Array.isArray(rel?.deals) ? rel.deals : []);
        setBenchmarks(bench?.benchmarks && typeof bench.benchmarks === "object" ? bench.benchmarks : {});
      } catch {
        if (cancelled) return;
        setRelativeDeals([]);
        setBenchmarks({});
      } finally {
        if (!cancelled) setRelativeLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [data, isGolazos, isUfc, collectionSlug]);

  // Reset countdown whenever the feed key (filters) changes.
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL);
  }, [feedKey]);

  // Resolve ?moment={momentId} → deal.flowId once the feed loads. Sets the
  // highlight + scrolls the row into view if the deal is still listed.
  // If the listing was removed between Fast Break click and arrival here,
  // the banner falls back to "removed" copy without applying any filter
  // (minimum-viable per Prompt 4.5 — a player-filter fallback would need a
  // name lookup endpoint that doesn't exist yet).
  useEffect(() => {
    if (!deepLinkMomentId || deepLinkDismissed) return;
    if (!data?.deals) return;
    const found = data.deals.find((d) => d.momentId === deepLinkMomentId);
    if (found) {
      setHighlightedId(found.flowId);
      setDeepLinkResolved("found");
      requestAnimationFrame(() => {
        const el = document.getElementById(`sniper-row-${found.flowId}`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    } else {
      setDeepLinkResolved("missing");
    }
  }, [deepLinkMomentId, deepLinkDismissed, data]);

  useEffect(() => {
    if (paused || tabHidden) return;
    countdownRef.current = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { refresh(); return REFRESH_INTERVAL; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(countdownRef.current!);
  }, [paused, tabHidden, refresh]);

  // ── Task 10: Page Visibility API — pause polling when tab hidden
  useEffect(() => {
    function handleVisibility() {
      if (document.hidden) {
        setTabHidden(true);
      } else {
        setTabHidden(false);
        setResumedIndicator(true);
        refresh();
        setCountdown(REFRESH_INTERVAL);
        setTimeout(() => setResumedIndicator(false), 2000);
      }
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [refresh]);

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
  };

  // ── Empty-sniper diagnostic beacon (beta_feedback_inbox #402) ────────────
  // Fires once per browser session when the empty-state renders, so we can
  // distinguish: server returned zero deals, server returned deals but the
  // visibleDeals filter zeroed them, or fetch failed (auth/cookie/ITP). The
  // beacon hits /api/public/log/empty-sniper which is outside proxy.ts auth,
  // so iPhone Safari with broken session cookies still gets through.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (loading) return;

    const isFetchFailed = !data && !!error;
    const isEmptyAfterFilter = !!data && visibleDeals.length === 0;
    if (!isFetchFailed && !isEmptyAfterFilter) return;

    const sessionKey = `rpc_empty_sniper_beacon:${collectionSlug}`;
    try {
      if (sessionStorage.getItem(sessionKey)) return;
      sessionStorage.setItem(sessionKey, String(Date.now()));
    } catch {
      // sessionStorage blocked (iOS private mode etc.) — fire anyway, single visit.
    }

    const payload = {
      ua: navigator.userAgent,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      screen: { w: window.screen.width, h: window.screen.height },
      pixelRatio: window.devicePixelRatio,
      collection: collectionSlug,
      feedKey,
      fetchStatus: isFetchFailed ? "failed" : "ok",
      fetchError: isFetchFailed ? String(error) : null,
      serverDealsCount: data?.deals?.length ?? null,
      visibleDealsCount: visibleDeals.length,
      tsCount: data?.tsCount ?? null,
      flowtyCount: data?.flowtyCount ?? null,
      hasOwnerKey: !!ownerKey,
      filters: {
        tierTab, sortBy, minDiscount, maxPrice, serialFilter,
        badgeOnly, flowWalletOnly, search, showVerifiedOnly, ownedFilter,
        playerFilter,
      },
      pageUrl: window.location.href,
      clientTs: new Date().toISOString(),
    };

    try {
      fetch("/api/public/log/empty-sniper", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* noop */
    }
  }, [loading, data, error, visibleDeals.length, collectionSlug, feedKey, ownerKey, tierTab, sortBy, minDiscount, maxPrice, serialFilter, badgeOnly, flowWalletOnly, search, showVerifiedOnly, ownedFilter, playerFilter]);

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
                  ? "LIVE PINNACLE DEALS BELOW FMV — VARIANT-AWARE"
                  : "LIVE DEALS BELOW ADJUSTED FMV — BADGE-AWARE, SERIAL-ADJUSTED"}
              </p>
            </div>
            <div className="flex items-center gap-3">
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
                onClick={() => { refresh(); setCountdown(REFRESH_INTERVAL); }}
                disabled={loading}
                className="rpc-btn-ghost"
                style={{ opacity: loading ? 0.5 : 1, borderColor: `${accent}40`, color: accent }}
              >
                {loading ? "↻" : "↻ REFRESH"}
              </button>
            </div>
          </div>

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
            {!isAllDay && (
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
            )}
            <LeagueFilter value={leagueFilter} onChange={setLeagueFilter} visible={collectionSlug === "nba-top-shot"} />
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
            {/* All Day has no badge system, so the toggle and downstream
                badge stats are hidden for nfl-all-day (same as Pinnacle). */}
            {!isPinnacle && !isAllDay && (
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
            {!isAllDay && ownedIds.size > 0 && (
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
        </div>
      </div>

      {/* Stats bar */}
      <div style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface-raised)", padding: "8px 16px" }}>
        <div className="rpc-mono flex items-center gap-6 flex-wrap" style={{ maxWidth: "var(--max-width)", margin: "0 auto", color: "var(--rpc-text-muted)" }}>
          <span><span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{stats.total}</span> deals</span>
          <span><span style={{ color: "var(--rpc-danger)", fontWeight: 600 }}>{stats.hot}</span> hot (40%+)</span>
          {!isPinnacle && !isAllDay && stats.badge > 0 && (
            <span><span style={{ color: "var(--tier-legendary)", fontWeight: 600 }}>{stats.badge}</span> badged</span>
          )}
          {!isAllDay && stats.special > 0 && (
            <span><span style={{ color: "#c084fc", fontWeight: 600 }}>{stats.special}</span> special serials</span>
          )}
          <span>avg <span style={{ color: "var(--rpc-text-primary)", fontWeight: 600 }}>{fmt(stats.avgDiscount, 1)}%</span> off</span>
          {!isAllDay && ownedIds.size > 0 && (
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
        {error && (
          <div className="rpc-hud" style={{ marginBottom: 16, borderColor: "var(--rpc-danger)", color: "var(--rpc-danger)", fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)" }}>
            FEED ERROR: {error}
          </div>
        )}

        {deepLinkMomentId && !deepLinkDismissed && deepLinkResolved !== "pending" && (
          <div
            className="rpc-hud"
            role="status"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginBottom: 16,
              borderColor: deepLinkResolved === "found" ? `${accent}66` : "var(--rpc-warning)",
              color: deepLinkResolved === "found" ? accent : "var(--rpc-warning)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--text-sm)",
            }}
          >
            <span style={{ flex: 1 }}>
              {deepLinkResolved === "found"
                ? "Showing the listing you came from Fast Break."
                : "That listing was just removed — here are tonight's deals."}
            </span>
            <button
              type="button"
              onClick={dismissDeepLinkBanner}
              aria-label="Dismiss Fast Break deep link"
              style={{
                background: "transparent",
                border: "1px solid currentColor",
                borderRadius: 4,
                color: "inherit",
                padding: "2px 8px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                cursor: "pointer",
              }}
            >
              ✕
            </button>
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

        {/* ── Relative-deals fallback for ASK_ONLY collections ─────────────── */}
        {(isGolazos || isUfc) && !loading && relativeDeals !== null && (
          <div style={{ marginBottom: 24 }}>
            <div className="rpc-hud" style={{ marginBottom: 12, borderColor: `${accent}66`, color: accent, fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)" }}>
              DEALS BASED ON TIER MEDIAN PRICING (LIMITED SALES DATA)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 260px", gap: 16 }}>
              <div className="rpc-card" style={{ padding: 12, overflow: "auto" }}>
                <div className="rpc-label" style={{ marginBottom: 8 }}>RELATIVE DEALS · TIER MEDIAN</div>
                {relativeLoading ? (
                  <div className="rpc-skeleton" style={{ width: "100%", height: 80 }} />
                ) : relativeDeals.length === 0 ? (
                  <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
                    No relative deals right now. Benchmark data may be too thin.
                  </p>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }}>
                    <thead>
                      <tr style={{ color: "var(--rpc-text-muted)", textAlign: "left" }}>
                        <th style={{ padding: "6px 8px" }}>PLAYER</th>
                        <th style={{ padding: "6px 8px" }}>SET</th>
                        <th style={{ padding: "6px 8px" }}>TIER</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>ASK</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>TIER MED</th>
                        <th style={{ padding: "6px 8px", textAlign: "right" }}>Δ</th>
                        <th style={{ padding: "6px 8px" }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {relativeDeals.map((d, idx) => {
                        const ask = Number(d.ask_price ?? 0);
                        const med = Number(d.tier_median ?? 0);
                        const disc = Number(d.discount_pct ?? 0);
                        return (
                          <tr key={idx} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                            <td style={{ padding: "6px 8px", color: "var(--rpc-text-primary)" }}>
                              {d.player_name ?? "—"}
                              {d.serial_number ? <span style={{ color: "var(--rpc-text-muted)" }}> #{d.serial_number}</span> : null}
                            </td>
                            <td style={{ padding: "6px 8px", color: "var(--rpc-text-muted)" }}>{d.set_name ?? "—"}</td>
                            <td style={{ padding: "6px 8px", color: accent, textTransform: "uppercase" }}>{d.tier ?? "—"}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right" }}>${ask.toFixed(2)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--rpc-text-muted)" }}>${med.toFixed(2)}</td>
                            <td style={{ padding: "6px 8px", textAlign: "right", color: "#00e882" }}>{disc}%</td>
                            <td style={{ padding: "6px 8px" }}>
                              {d.buy_url ? (
                                <a href={d.buy_url} target="_blank" rel="noopener noreferrer" className="rpc-chip" style={{ borderColor: `${accent}66`, color: accent, padding: "2px 8px", fontSize: "var(--text-xs)" }}>
                                  View →
                                </a>
                              ) : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="rpc-card" style={{ padding: 12 }}>
                <div className="rpc-label" style={{ marginBottom: 8 }}>TIER BENCHMARKS</div>
                {benchmarks && Object.keys(benchmarks).length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)" }}>
                    <thead>
                      <tr style={{ color: "var(--rpc-text-muted)" }}>
                        <th style={{ padding: "4px 6px", textAlign: "left" }}>TIER</th>
                        <th style={{ padding: "4px 6px", textAlign: "right" }}>N</th>
                        <th style={{ padding: "4px 6px", textAlign: "right" }}>FLOOR</th>
                        <th style={{ padding: "4px 6px", textAlign: "right" }}>MEDIAN</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(benchmarks).map(([tier, s]) => (
                        <tr key={tier} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                          <td style={{ padding: "4px 6px", color: accent, textTransform: "uppercase" }}>{tier}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>{s.count}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>${Number(s.floor ?? 0).toFixed(2)}</td>
                          <td style={{ padding: "4px 6px", textAlign: "right" }}>${Number(s.median ?? 0).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-xs)" }}>No benchmarks available.</p>
                )}
              </div>
            </div>
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
              return (
                <div key={`m-${deal.source}-${deal.flowId}`} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("a,button")) return; setSelectedDeal(deal); }} className="rpc-card p-3 flex flex-col gap-1.5 cursor-pointer">
                  {/* Row 1: Thumbnail + Player + Tier + Source */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {deal.thumbnailUrl ? (
                        <img
                          src={deal.thumbnailUrl}
                          alt={deal.playerName}
                          width={36}
                          height={36}
                          loading="lazy"
                          className="rounded object-cover shrink-0"
                          style={{ width: 36, height: 36, background: "var(--rpc-surface)" }}
                          onClick={(e) => { e.stopPropagation(); setSelectedDeal(deal); }}
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
                        />
                      ) : null}
                      {deal.editionKey ? (
                        <Link
                          href={`/${collectionSlug}/edition/${encodeURIComponent(deal.editionKey)}`}
                          prefetch={false}
                          style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", textDecoration: "none" }}
                          className="truncate"
                        >
                          {deal.playerName}
                        </Link>
                      ) : (
                        <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)" }} className="truncate">{deal.playerName}</span>
                      )}
                      {isPinnacle ? (
                        <span style={{ color: variantColor(deal.tier), fontWeight: 600, fontSize: "var(--text-xs)", border: `1px solid ${variantColor(deal.tier)}40`, background: `${variantColor(deal.tier)}15`, borderRadius: 3, padding: "0 4px" }}>
                          {deal.tier}
                        </span>
                      ) : (
                        <span style={{ color: resolveTierColor(deal.tier, isAllDay), fontWeight: 600, fontSize: "var(--text-xs)" }}>
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
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)", fontSize: "var(--text-sm)" }}>{deal.serial === 0 ? "Floor" : `#${deal.serial}`}</span>
                      <SerialBadge deal={deal} />
                      {deal.isJersey && (
                        <span className="rpc-chip" style={{ background: "rgba(20,184,166,0.15)", borderColor: "rgba(20,184,166,0.3)", color: "#5eead4", fontSize: 9, padding: "1px 5px" }}>Jersey</span>
                      )}
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>${fmt(deal.askPrice)}</span>
                    <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold" style={{ fontFamily: "var(--font-mono)", ...discountColor(deal.discount) }}>
                      {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                    </span>
                  </div>
                  {/* Row 4: Adj. FMV + Listed + Own/Lock + Action */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)" }}>Adj. FMV ${fmt(deal.adjustedFmv)}</span>
                    <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-text-ghost)" }}>Listed {timeAgo(deal.updatedAt)}</span>
                    {(() => {
                      // AllDay + Pinnacle keys don't match wallet_moments_cache.edition_key
                      // shape today (AllDay sniper feed emits "set:play"; wmc stores plain
                      // "play". Pinnacle skips the editionStats fetch entirely). Until
                      // those mappings are unified, hide the chip rather than mislead.
                      if (isAllDay || isPinnacle) return null;
                      if (!ownerKey) {
                        return (
                          <Link
                            href={`/${collectionSlug}/collection`}
                            prefetch={false}
                            style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)", textDecoration: "underline" }}
                          >
                            Sign in to see ownership
                          </Link>
                        );
                      }
                      const eStats =
                        (deal.editionKey && editionStats.get(deal.editionKey)) ||
                        (deal.intEditionKey && editionStats.get(deal.intEditionKey)) ||
                        null;
                      if (eStats && eStats.owned > 0) {
                        return (
                          <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-success)" }} title={`${eStats.owned} owned · ${eStats.locked} locked`}>
                            Own {eStats.owned} / Lock {eStats.locked}
                          </span>
                        );
                      }
                      return (
                        <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-text-ghost)" }} title="You don't own any copies of this edition">
                          Not owned
                        </span>
                      );
                    })()}
                    {!isPinnacle && deal.hasBadge && deal.badgeSlugs.length > 0 && (
                      <div className="flex gap-1 flex-wrap items-center">
                        {Array.from(new Set(deal.badgeSlugs)).slice(0, 3).map((slug) => (
                          <BadgeIcon key={slug} title={slug} />
                        ))}
                      </div>
                    )}
                    {(() => {
                      const viewUrl = resolveViewUrl(deal, feedCollection);
                      const dapperUrl = resolveDapperUrl(deal, feedCollection);
                      if (!viewUrl && !dapperUrl) return null;
                      return (
                        <div className="flex gap-1.5 flex-wrap">
                          {viewUrl && (
                            <a
                              href={viewUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => { e.stopPropagation(); trackClick(deal, null); }}
                              className="rpc-btn-ghost"
                              style={{ padding: "4px 10px", textDecoration: "none", borderColor: `${accent}40`, color: accent, fontSize: "var(--text-xs)" }}
                            >
                              View Listing →
                            </a>
                          )}
                          {dapperUrl && (
                            <a
                              href={dapperUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => { e.stopPropagation(); trackClick(deal, null); }}
                              className="rpc-btn-ghost"
                              style={{ padding: "4px 10px", textDecoration: "none", borderColor: `${accent}40`, color: accent, fontSize: "var(--text-xs)" }}
                            >
                              Dapper ↗
                            </a>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {visibleDeals.length > 0 && !isMobile && (
          <div className="rpc-card" style={{ overflow: "auto", WebkitOverflowScrolling: "touch", borderRadius: "var(--radius-md)", maxWidth: "100%" }}>
            <table style={{ width: "100%", minWidth: 980, fontSize: "var(--text-sm)", fontFamily: "var(--font-mono)", borderCollapse: "collapse" }}>
              <thead>
                <tr className="rpc-thead-scanline" style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
                  <th className="rpc-label" style={{ textAlign: "left", padding: "10px 12px 10px 10px" }}>Moment</th>
                  <th className="rpc-label" style={{ textAlign: "right", padding: "10px 12px 10px 4px" }}>Serial</th>
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
                      <td style={{ padding: "8px 4px 8px 10px", maxWidth: 360 }}>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div style={{ width: 56, height: 56, borderRadius: 6, background: "var(--rpc-surface-raised)", flexShrink: 0 }} />
                          <div>
                            <div style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}>{deal.playerName}</div>
                            <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>{deal.setName}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: "8px 12px 8px 4px", textAlign: "right", fontFamily: "var(--font-mono)" }}>#{deal.serial}</td>
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
                    id={`sniper-row-${deal.flowId}`}
                    className={`${holoClass(deal.tier)}${deal.flowId === highlightedId ? " ring-2" : ""}${deal.discount >= 40 ? " rpc-hot-deal" : ""}`}
                    style={{ borderBottom: expandedFlowId === deal.flowId ? "none" : "1px solid var(--rpc-border)", transition: "background var(--transition-fast)", cursor: "pointer", ...(deal.flowId === highlightedId ? { boxShadow: `0 0 0 2px ${accent}80`, background: `${accent}12` } : {}) }}
                    onClick={() => toggleEditionDepth(deal)}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--rpc-surface-hover)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = deal.discount >= 40 ? "rgba(224,58,47,0.08)" : "transparent"; }}
                  >
                    {/* Moment info */}
                    <td style={{ padding: "8px 4px 8px 10px", maxWidth: 360 }}>
                      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        {deal.thumbnailUrl ? (
                          <SniperThumbnailPreview thumbUrl={deal.thumbnailUrl} playerName={deal.playerName} tierColor={resolveTierColor(deal.tier, isAllDay)} backgroundColor={isAllDay ? "#1a1a1a" : undefined}>
                            <img
                              src={isAllDay ? deal.thumbnailUrl.replace("width=256", "width=512") : deal.thumbnailUrl}
                              alt={deal.playerName}
                              width={56}
                              height={56}
                              style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, flexShrink: 0, background: "#1a1a1a", cursor: "pointer", boxShadow: `0 0 0 1px ${resolveTierColor(deal.tier, isAllDay)}40`, transition: "box-shadow var(--transition-fast)" }}
                              loading="lazy"
                              decoding="async"
                              onClick={(e) => { e.stopPropagation(); setSelectedDeal(deal); }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLImageElement).style.boxShadow = `0 0 0 2px ${resolveTierColor(deal.tier, isAllDay)}` }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLImageElement).style.boxShadow = `0 0 0 1px ${resolveTierColor(deal.tier, isAllDay)}40` }}
                              onError={(e) => {
                                const img = e.currentTarget as HTMLImageElement;
                                img.onerror = null;
                                img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
                              }}
                            />
                          </SniperThumbnailPreview>
                        ) : (
                          <div
                            aria-label={deal.playerName}
                            style={{
                              width: 56,
                              height: 56,
                              borderRadius: 6,
                              flexShrink: 0,
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontFamily: "var(--font-display)",
                              fontWeight: 800,
                              fontSize: 22,
                              color: "rgba(255,255,255,0.9)",
                              background: `linear-gradient(135deg, ${resolveTierColor(deal.tier, isAllDay)}55, ${resolveTierColor(deal.tier, isAllDay)}22)`,
                              boxShadow: `0 0 0 1px ${resolveTierColor(deal.tier, isAllDay)}40`,
                            }}
                          >
                            {(deal.playerName || "?").trim().charAt(0).toUpperCase() || "?"}
                          </div>
                        )}
                        <div style={{ minWidth: 0 }}>
                      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, color: "var(--rpc-text-primary)", lineHeight: 1.2 }}>
                        {deal.editionKey ? (
                          <Link
                            href={`/${collectionSlug}/edition/${encodeURIComponent(deal.editionKey)}`}
                            prefetch={false}
                            onClick={(e) => e.stopPropagation()}
                            style={{ color: "inherit", textDecoration: "none" }}
                          >
                            {deal.playerName}
                          </Link>
                        ) : (
                          deal.playerName
                        )}
                      </div>
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
                          <span className={deal.tier.toUpperCase() === "LEGENDARY" ? "rpc-tier-glow-legendary" : deal.tier.toUpperCase() === "ULTIMATE" ? "rpc-tier-glow-ultimate" : deal.tier.toUpperCase() === "RARE" ? "rpc-tier-glow-rare" : ""} style={{ color: resolveTierColor(deal.tier, isAllDay), fontWeight: 600 }}>
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
                      {!isAllDay && (ownedCountByEdition.get(deal.editionKey || deal.momentId) ?? 0) > 0 && (
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
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {Array.from(new Set(deal.badgeSlugs)).slice(0, 4).map((slug) => (
                            <BadgeIcon key={slug} title={slug} size={24} />
                          ))}
                        </div>
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
                    <td style={{ padding: "8px 12px 8px 4px", textAlign: "right" }}>
                      <div style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)" }}>{deal.serial === 0 ? "Floor" : `#${deal.serial}`}</div>
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

                    {/* Own / Lock — three explicit states: ownership match
                        (success "X / Y"), signed-in but no copies ("Not
                        owned"), or signed-out (link to /collection so the
                        page can write rpc_owner_key from username lookup). */}
                    <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}>
                      {(() => {
                        if (isAllDay || isPinnacle) return "—";
                        if (!ownerKey) {
                          return (
                            <Link
                              href={`/${collectionSlug}/collection`}
                              prefetch={false}
                              style={{ color: "var(--rpc-text-muted)", textDecoration: "underline" }}
                            >
                              Sign in
                            </Link>
                          );
                        }
                        const eStats =
                          (deal.editionKey && editionStats.get(deal.editionKey)) ||
                          (deal.intEditionKey && editionStats.get(deal.intEditionKey)) ||
                          null;
                        if (eStats && eStats.owned > 0) {
                          return (
                            <span style={{ color: "var(--rpc-success)" }} title={`${eStats.owned} owned · ${eStats.locked} locked`}>
                              {eStats.owned} / {eStats.locked}
                            </span>
                          );
                        }
                        return (
                          <span style={{ color: "var(--rpc-text-ghost)" }} title="You don't own any copies of this edition">
                            Not owned
                          </span>
                        );
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
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold" style={{ fontFamily: "var(--font-mono)", ...discountColor(deal.discount) }}>
                        {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                      </span>
                    </td>

                    {/* Share */}
                    <td style={{ padding: "8px 4px", textAlign: "center" }}>
                      <ShareButton deal={deal} />
                    </td>

                    {/* Action */}
                    <td style={{ padding: "8px 12px" }} onClick={(e) => e.stopPropagation()}>
                      <ActionCell deal={deal} accent={accent} collectionSlug={feedCollection} />
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
                                    {(() => {
                                      const ddUrl = resolveViewUrl(dd, feedCollection);
                                      const ddDapper = resolveDapperUrl(dd, feedCollection);
                                      return (
                                        <span className="flex items-center gap-3">
                                          {ddUrl && <a href={ddUrl} target="_blank" rel="noopener noreferrer" style={{ color: accent, textDecoration: "none" }}>View →</a>}
                                          {ddDapper && <a href={ddDapper} target="_blank" rel="noopener noreferrer" style={{ color: accent, textDecoration: "none" }}>Dapper ↗</a>}
                                        </span>
                                      );
                                    })()}
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
          buyUrl: resolveViewUrl(selectedDeal, feedCollection) ?? selectedDeal.buyUrl,
        } : null}
        marketplaceSource={selectedDeal?.source === "flowty" ? "flowty" : "topshot"}
        dapperUrl={selectedDeal ? resolveDapperUrl(selectedDeal, feedCollection) : null}
        onClose={() => setSelectedDeal(null)}
      />
    </div>
  );
}