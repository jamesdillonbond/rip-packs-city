"use client";
import React from "react";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useWarmCache } from "@/lib/warmup/WarmupContext";
import { getCollection, COLLECTION_UUID_BY_SLUG } from "@/lib/collections";
import { PackSubNav, subSectionFromParams } from "@/components/collection/PackSubNav";
import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient";
import { getOwnerKey } from "@/lib/owner-key";
import { slugifyName } from "@/lib/entity-labels";
import MomentDetailModal from "@/components/MomentDetailModal";
import BadgeIcon from "@/components/BadgeIcon";
import SerialFmvBadge from "@/components/SerialFmvBadge";
import NetOfFeesNote from "@/components/sniper/NetOfFeesNote";
import { type LeagueValue } from "@/components/filters/LeagueFilter";
import { track } from "@/lib/telemetry/track";
import { proxyIpfsUrl } from "@/lib/ipfs-media";
import { useMobile } from "@/components/collection/use-mobile";
import { SniperThumbnailPreview } from "@/components/sniper/SniperThumbnailPreview";
import { SerialBadge } from "@/components/sniper/SerialBadge";
import SpecialSerialGlyph from "@/components/SpecialSerialGlyph";
import { ActionCell } from "@/components/sniper/ActionCell";
import SniperFilterBar from "@/components/sniper/SniperFilterBar";
import SniperStatsBar from "@/components/sniper/SniperStatsBar";
import { MarketplaceStatusBanner } from "@/components/marketplace-status";
import type { SniperDeal, FeedResult, SortOption } from "@/lib/sniper/types";
import {
  sniperFeedDegraded,
  sniperEmptyCopy,
  SNIPER_DEGRADED_EMPTY_COPY,
  SNIPER_DEGRADED_EMPTY_HEADING,
} from "@/lib/sniper/source-failures";
import {
  buildListingSuggestions,
  suggestionsState,
  type ListingSuggestion,
  type OwnedMoment,
  type SuggestionsState,
} from "@/lib/sniper/listing-suggestions";
import {
  filterSniperDeals,
  sortByVerifiedFirst,
  computeSniperStats,
  trackClick,
  resolveViewUrl,
  resolveDapperUrl,
  timeAgo,
  fmt,
  fmvDisplay,
  safeRatioDiff,
  resolveTierColor,
  variantColor,
  holoClass,
  discountColor,
  countHiddenByVerifiedGate,
} from "@/lib/sniper/helpers";
import { sniperTierTabs } from "@/lib/collection-tiers";

// ─── Main page ────────────────────────────────────────────────────────────────

const REFRESH_INTERVAL = 30;
// Tier chips are DRIVEN BY THE COLLECTION'S REAL VOCABULARY (lib/collection-tiers).
// They used to be one hardcoded Top Shot list plus a Golazos special case, which
// meant UFC Strike rendered common/uncommon/fandom/rare/legendary/ultimate — five
// chips that can never match, leaving 515 of its 518 editions unfilterable (UFC is
// CONTENDER 460 / CHALLENGER 55 / FANDOM 2 / CHAMPION 1). Fixed 2026-08-01.
const PINNACLE_VARIANT_TABS = ["all", "Standard", "Brushed Silver", "Colored Enamel", "Golden", "Digital Display", "Limited Edition"] as const;
type TierTab = string;

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: "listed_desc", label: "Recently Listed" },
  { value: "discount",    label: "Best Discount" },
  { value: "price_asc",   label: "Cheapest First" },
  { value: "price_desc",  label: "Most Expensive" },
  { value: "fmv_desc",    label: "Highest FMV" },
  { value: "serial_asc",  label: "Lowest Serial" },
];

function SniperMomentsBody() {
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
  // Collection UUID for collection-scoped badge art (BadgeIcon → badge_taxonomy
  // RPC). Badges are hidden for Pinnacle, so keying off the route slug is safe.
  const badgeCollectionId = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? null;
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
  // P2.5 — default ON: the credible verified-FMV view leads. Users can toggle
  // it off to also see thin-data deals (demoted + flagged, never headlined).
  const [showVerifiedOnly, setShowVerifiedOnly] = useState(true);
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
  const [suggestions, setSuggestions] = useState<ListingSuggestion[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  /**
   * ⚠ The panel's empty copy is a CONCLUSION — "Your moments are priced at or
   * below current market asks" — so it may only be published when we actually
   * compared. Three failure paths used to land on it: a non-2xx snapshot read,
   * a thrown fetch, and the deals feed not having loaded.
   */
  const [suggestionsState_, setSuggestionsState] = useState<SuggestionsState>("none");

  // ── Task 1: "Just Sold" ghost listings ──────────────────────────────────────
  const prevDealIdsRef = useRef<Set<string>>(new Set());
  const [soldIds, setSoldIds] = useState<Set<string>>(new Set());
  const [soldDeals, setSoldDeals] = useState<Map<string, SniperDeal>>(new Map());

  // ── Task 2: Edition depth panel ─────────────────────────────────────────────
  const [expandedEditionKey, setExpandedEditionKey] = useState<string | null>(null);
  const [expandedFlowId, setExpandedFlowId] = useState<string | null>(null);
  const [selectedDeal, setSelectedDeal] = useState<SniperDeal | null>(null);
  const router = useRouter();
  // Full-card click target: navigate to the asset's entity page. Edition page
  // when we have an int edition key, else the serial-specific moment page.
  const dealHref = (d: SniperDeal) => d.editionKey
    ? `/${collectionSlug}/edition/${encodeURIComponent(d.editionKey)}`
    : `/moment/${d.flowId}`;
  const [depthDeals, setDepthDeals] = useState<SniperDeal[]>([]);
  const [depthLoading, setDepthLoading] = useState(false);
  const [depthFloor, setDepthFloor] = useState<{
    topShotFloor: number | null; topShotListingCount: number;
    flowtyFloor: number | null; flowtyListingCount: number;
    crossMarketFloor: number | null; crossMarketSource: string | null;
    livetokenFmv: number | null;
  } | null>(null);
  const [depthFloorError, setDepthFloorError] = useState<string | null>(null);
  // ⚠ The depth panel has TWO legs and only the floor one reported failure. The
  // listings leg swallowed both its exits, so a failed read rendered "No other
  // listings for this edition." — on the surface a collector uses to decide
  // whether the listing in front of them is the cheapest one. The panel was
  // half-honest: an explicit floor error sat directly above a fabricated
  // statement about supply.
  const [depthListingsError, setDepthListingsError] = useState<string | null>(null);

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
  const [relativeFailed, setRelativeFailed] = useState(false);

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
  // ⚠ A 200 with `deals: []` is NOT evidence the floor is quiet. Each of the
  // feed's deal-bearing reads (ts_listings, the All Day marketplace GQL, the
  // two deal RPCs, the All Day FMV map) used to collapse to an empty list on
  // failure, and the empty state then told the reader to widen filters that
  // were never the reason. `sourcesFailed` names the reads that failed; empty
  // means we actually looked. (see lib/sniper/source-failures.ts)
  const sourcesFailed = data?.sourcesFailed;
  const feedDegraded = sniperFeedDegraded(sourcesFailed);

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
    setRelativeFailed(false);
    (async () => {
      try {
        const [rel, bench] = await Promise.all([
          fetch(`/api/relative-deals?collection=${encodeURIComponent(collectionSlug)}&minDiscount=10&limit=50`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
          fetch(`/api/tier-pricing-benchmarks?collection=${encodeURIComponent(collectionSlug)}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
        ]);
        if (cancelled) return;
        // ⚠ A non-2xx and a thrown fetch both arrive with no deals. Rendering
        // that as the empty state prints "Benchmark data may be too thin." — a
        // DIAGNOSIS of a cause that is not the cause, which is worse than a bare
        // empty state because it sends the reader to fix the wrong thing (same
        // shape as the "try a longer time range" copy fixed 2026-08-12).
        if (!Array.isArray(rel?.deals)) { setRelativeFailed(true); setRelativeDeals([]); }
        else setRelativeDeals(rel.deals);
        setBenchmarks(bench?.benchmarks && typeof bench.benchmarks === "object" ? bench.benchmarks : {});
      } catch {
        if (cancelled) return;
        setRelativeFailed(true);
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
    setDepthListingsError(null);

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
        // ⚠ This was a bare `return`, which is the likelier failure of the two
        // (a 5xx response, not a thrown fetch) and left depthDeals at [] — read
        // by the panel below as "none exist".
        if (!res.ok) { setDepthListingsError("Could not load other listings"); return; }
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
      .catch(() => setDepthListingsError("Could not load other listings"));

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

  // P2.5 — filter (discount>=0 + search + Verified-only + owned gate) then demote
  // thin/low-confidence deals below verified ones so real deals lead when the
  // Verified-only toggle is off (stable sort preserves the API order within each
  // group). Headline "hot"/avg-discount reflect the VERIFIED subset only so the
  // top-of-page numbers can't be inflated by thin-FMV fake bargains. Extracted to
  // lib/sniper/helpers (filterSniperDeals / sortByVerifiedFirst / computeSniperStats).
  const visibleDeals = sortByVerifiedFirst(
    filterSniperDeals(data?.deals ?? [], { search, showVerifiedOnly, ownedFilter, ownedIds }),
  );
  const stats = computeSniperStats(visibleDeals);

  // How many listings pass every OTHER filter and are hidden solely by the
  // default-on Verified-FMV gate (deep-audit D4). On Top Shot this is routinely
  // the whole board: the feed is dominated by ask-derived rows where FMV *is*
  // the ask, so the spread is 0% and isVerifiedDeal correctly rejects them.
  //
  // The gate is right and stays on — headlining a 0%-spread ask-priced row as a
  // "deal" is the fabricated-signal class. What was wrong is that the empty
  // state blamed "your filters" for a filter the user never set, next to a KPI
  // row reading "0 deals", so a live board with 200 listings looked like a dead
  // market. Naming the real cause lets the user make an informed choice instead
  // of concluding the feature is broken.
  const hiddenByVerifiedGate = countHiddenByVerifiedGate(data?.deals ?? [], {
    search,
    showVerifiedOnly,
    ownedFilter,
    ownedIds,
  });

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
      // A 200 whose deal-bearing reads failed reads as "ok" above. Without
      // these two the beacon cannot tell a degraded build from a quiet floor.
      degraded: feedDegraded,
      sourcesFailed: sourcesFailed ?? null,
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
  }, [loading, data, error, feedDegraded, sourcesFailed, visibleDeals.length, collectionSlug, feedKey, ownerKey, tierTab, sortBy, minDiscount, maxPrice, serialFilter, badgeOnly, flowWalletOnly, search, showVerifiedOnly, ownedFilter, playerFilter]);

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
              {/* Front door to the omni-channel alerts hub — turn a deal you're
                  eyeing into a standing alert. Auth-gated; anon bounces to login. */}
              <Link
                href="/alerts"
                className="rpc-chip"
                style={{ textDecoration: "none", color: "var(--rpc-red)", borderColor: "var(--rpc-red)" }}
                title="Get notified when deals like these appear"
              >
                🔔 ALERT ME
              </Link>
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
                      // ⚠ null means WE COULD NOT READ, and it must stay
                      // distinguishable from a collection that holds nothing.
                      .then((r) => r.ok ? r.json() : null)
                      .then((snapshot) => {
                        const owned: OwnedMoment[] | null = snapshot?.topMoments
                          ? (snapshot.topMoments as OwnedMoment[])
                          : null;
                        const results = owned && data?.deals
                          ? buildListingSuggestions(owned, data.deals)
                          : [];
                        setSuggestions(results);
                        setSuggestionsState(
                          suggestionsState({ ownedMoments: owned, deals: data?.deals, resultCount: results.length }),
                        );
                        setSuggestionsLoading(false);
                      })
                      .catch(() => {
                        // `fetch` THROWS on a network failure rather than
                        // resolving non-ok — the same false conclusion by a
                        // second route.
                        setSuggestions([]);
                        setSuggestionsState("read-failed");
                        setSuggestionsLoading(false);
                      });
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

          {/* Honest marketplace-status notice — renders only for non-healthy
              collections (e.g. UFC Strike: no active Flow market, migrated to
              Aptos, deals below are historical). Null for healthy collections. */}
          <div style={{ marginBottom: 12 }}>
            <MarketplaceStatusBanner collectionSlug={collectionSlug} />
          </div>

          <SniperFilterBar
            isMobile={isMobile}
            isPinnacle={isPinnacle}
            isAllDay={isAllDay}
            isGolazos={isGolazos}
            accent={accent}
            collectionSlug={collectionSlug}
            showFilters={showFilters}
            onToggleFilters={() => setShowFilters((v) => !v)}
            playerInput={playerInput}
            onPlayerChange={handlePlayerChange}
            tierTab={tierTab}
            tabs={isPinnacle ? PINNACLE_VARIANT_TABS : sniperTierTabs(collectionSlug)}
            onTierChange={(t) => setTierTab(t as TierTab)}
            minDiscount={minDiscount}
            onMinDiscountChange={setMinDiscount}
            maxPrice={maxPrice}
            onMaxPriceChange={setMaxPrice}
            search={search}
            onSearchChange={setSearch}
            serialFilter={serialFilter}
            onSerialChange={setSerialFilter}
            sortBy={sortBy}
            sortOptions={SORT_OPTIONS}
            onSortChange={setSortBy}
            badgeOnly={badgeOnly}
            onBadgeOnlyChange={setBadgeOnly}
            showVerifiedOnly={showVerifiedOnly}
            onVerifiedChange={setShowVerifiedOnly}
            ownedFilter={ownedFilter}
            onOwnedFilterChange={setOwnedFilter}
            ownedCount={ownedIds.size}
            leagueFilter={leagueFilter}
            onLeagueChange={setLeagueFilter}
            saveSearchMsg={saveSearchMsg}
            onSaveSearch={handleSaveSearch}
          />
        </div>
      </div>

      {/* Stats bar */}
      <SniperStatsBar
        stats={stats}
        isPinnacle={isPinnacle}
        isAllDay={isAllDay}
        ownedCount={ownedIds.size}
        lastRefreshed={data?.lastRefreshed}
      />

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
                ) : relativeFailed ? (
                  <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
                    Couldn&apos;t load relative deals. This says nothing about the benchmark data —
                    only that the read failed.
                  </p>
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
              {/* brand-exception: SVG fill attr can't resolve a CSS var; pinwheel hub */}
              <circle cx="50" cy="50" r="7" fill="#080808" />
            </svg>
            <p className="rpc-heading" style={{ fontSize: "var(--text-lg)" }}>
              {feedDegraded
                ? SNIPER_DEGRADED_EMPTY_HEADING
                : hiddenByVerifiedGate > 0 ? "NO VERIFIED-FMV DEALS RIGHT NOW" : "THE FLOOR IS QUIET"}
            </p>
            {feedDegraded && hiddenByVerifiedGate > 0 && (
              <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.5 }}>
                {SNIPER_DEGRADED_EMPTY_COPY}
              </p>
            )}
            {hiddenByVerifiedGate > 0 ? (
              <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.5 }}>
                {hiddenByVerifiedGate} listing{hiddenByVerifiedGate === 1 ? " is" : "s are"} hidden by
                the <strong>Verified FMV only</strong> filter, which is on by default. Those editions
                have no recent sales to price against, so their FMV is derived from the ask itself —
                the &ldquo;discount&rdquo; is 0% by construction, not a deal. You can still browse them.
              </p>
            ) : (
              <p className="rpc-mono" style={{ color: "var(--rpc-text-muted)", maxWidth: 460, lineHeight: 1.5 }}>
                {sniperEmptyCopy(sourcesFailed, "No deals match your filters. Try widening your search.")}
              </p>
            )}
            {hiddenByVerifiedGate > 0 && (
              <button
                onClick={() => setShowVerifiedOnly(false)}
                className="rpc-btn-ghost" style={{ marginTop: 8, borderColor: `${accent}66`, color: accent }}
              >
                SHOW ASK-PRICED LISTINGS
              </button>
            )}
            {feedDegraded ? (
              // Clearing filters cannot recover a read that failed; offering it
              // is the same false diagnosis in button form.
              <button
                onClick={() => refresh()}
                className="rpc-btn-ghost" style={{ marginTop: 8, borderColor: `${accent}66`, color: accent }}
              >
                RETRY
              </button>
            ) : (
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
            )}
          </div>
        )}

        {visibleDeals.length > 0 && isMobile && (
          <div className="flex flex-col gap-2">
            {visibleDeals.map((deal) => {
              return (
                <div key={`m-${deal.source}-${deal.flowId}`} onClick={(e) => { const t = e.target as HTMLElement; if (t.closest("a,button")) return; router.push(dealHref(deal)); }} className="rpc-card p-3 flex flex-col gap-1.5 cursor-pointer">
                  {/* Row 1: Thumbnail + Player + Tier + Source */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <div
                        aria-label={deal.playerName}
                        onClick={(e) => { e.stopPropagation(); router.push(dealHref(deal)); }}
                        className="rounded shrink-0 relative overflow-hidden"
                        style={{
                          width: 36,
                          height: 36,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontFamily: "var(--font-display)",
                          fontWeight: 800,
                          fontSize: 15,
                          color: "var(--rpc-text-primary)",
                          background: `linear-gradient(135deg, ${resolveTierColor(deal.tier, isAllDay)}55, ${resolveTierColor(deal.tier, isAllDay)}22)`,
                        }}
                      >
                        {(deal.playerName || "?").trim().charAt(0).toUpperCase() || "?"}
                        {deal.thumbnailUrl ? (
                          <img
                            src={proxyIpfsUrl(deal.thumbnailUrl) ?? undefined}
                            alt={deal.playerName}
                            width={36}
                            height={36}
                            loading="lazy"
                            className="object-cover"
                            style={{ position: "absolute", inset: 0, width: 36, height: 36 }}
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none" }}
                          />
                        ) : null}
                      </div>
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
                  </div>
                  {/* Row 2: Set name + franchise */}
                  <div className="text-xs" style={{ color: "var(--rpc-text-muted)" }}>{deal.setName}{deal.seriesName ? ` · ${deal.seriesName}` : ""}{isPinnacle && deal.teamName ? ` · ${deal.teamName}` : ""}</div>
                  {/* Row 3: Serial + Ask + Discount */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1">
                      <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-secondary)", fontSize: "var(--text-sm)" }}>{deal.serial === 0 ? "Floor" : `#${deal.serial}`}</span>
                      <SerialBadge deal={deal} collection={collectionSlug} />
                      {deal.isJersey && (
                        <span className="rpc-chip" style={{ background: "rgba(20,184,166,0.15)", borderColor: "rgba(20,184,166,0.3)", color: "#5eead4", fontSize: 9, padding: "1px 5px", display: "inline-flex", alignItems: "center", gap: 3 }}><SpecialSerialGlyph tag="jersey" size={11} collection={collectionSlug} />Jersey</span>
                      )}
                    </div>
                    <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-primary)", fontSize: "var(--text-sm)", fontWeight: 600 }}>${fmt(deal.askPrice)}</span>
                    {deal.lowConfidenceFmv ? (
                      <span
                        title="FMV here is averaged over very few, wide-ranging sales, so it overshoots the typical price — this discount is uncertain. Check recent sales before acting."
                        style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--rpc-warning)", letterSpacing: "0.02em" }}
                      >
                        ⚠ thin data
                      </span>
                    ) : (
                      <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold" style={{ fontFamily: "var(--font-mono)", ...discountColor(deal.discount) }}>
                        {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                      </span>
                    )}
                  </div>
                  {/* Row 4: Adj. FMV + Listed + Own/Lock + Action */}
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span style={{ fontSize: "var(--text-xs)", fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)" }}>Adj. FMV {fmvDisplay(deal.adjustedFmv)}</span>
                      <NetOfFeesNote net={deal.netOfFees} />
                      {deal.serialFmvEstimate ? <SerialFmvBadge data={deal.serialFmvEstimate} /> : null}
                    </span>
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
                          <BadgeIcon key={slug} title={slug} collectionId={badgeCollectionId} />
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
                      <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmvDisplay(deal.adjustedFmv)}</td>
                      <td style={{ padding: "8px 12px", textAlign: "right" }}>
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/30 text-red-300 border border-red-500/50" style={{ fontFamily: "var(--font-mono)" }}>SOLD</span>
                      </td>
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
                          <SniperThumbnailPreview thumbUrl={deal.thumbnailUrl} playerName={deal.playerName} tierColor={resolveTierColor(deal.tier, isAllDay)} backgroundColor={isAllDay ? "var(--rpc-surface-raised)" : undefined}>
                            <img
                              src={proxyIpfsUrl(isAllDay ? deal.thumbnailUrl.replace("width=256", "width=512") : deal.thumbnailUrl) ?? undefined}
                              alt={deal.playerName}
                              width={56}
                              height={56}
                              style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, flexShrink: 0, background: "var(--rpc-surface-raised)", cursor: "pointer", boxShadow: `0 0 0 1px ${resolveTierColor(deal.tier, isAllDay)}40`, transition: "box-shadow var(--transition-fast)" }}
                              loading="lazy"
                              decoding="async"
                              onClick={(e) => { e.stopPropagation(); router.push(dealHref(deal)); }}
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
                              color: "var(--rpc-text-primary)",
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
                      {!isPinnacle && deal.hasBadge && deal.badgeSlugs.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          {Array.from(new Set(deal.badgeSlugs)).slice(0, 4).map((slug) => (
                            <BadgeIcon key={slug} title={slug} size={24} collectionId={badgeCollectionId} />
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
                          <span className="rpc-chip" title="Jersey match" style={{ background: "rgba(20,184,166,0.15)", borderColor: "rgba(20,184,166,0.3)", color: "#5eead4", fontSize: 9, padding: "1px 5px", display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <SpecialSerialGlyph tag="jersey" size={11} collection={collectionSlug} /> Jersey
                          </span>
                        )}
                        {deal.serial > 10 && String(deal.serial).endsWith("00") && (
                          <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.12)", borderColor: "rgba(168,85,247,0.25)", color: "#c084fc", fontSize: 9, padding: "1px 5px" }}>
                            ROUND
                          </span>
                        )}
                        {deal.serialSignal && !deal.isJersey && deal.serial > 10 && (
                          <span className="rpc-chip" style={{ background: "rgba(168,85,247,0.12)", borderColor: "rgba(168,85,247,0.25)", color: "#c084fc", fontSize: 9, padding: "1px 5px", display: "inline-flex", alignItems: "center", gap: 3 }}>
                            <SpecialSerialGlyph tag={deal.serial === 1 ? "#1" : "last_mint"} size={11} collection={collectionSlug} />{deal.serialSignal}
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
                        {fmvDisplay(deal.adjustedFmv)}
                        {/* Trend arrow needs a real, non-zero baseFmv as the
                            denominator. Feeds can legitimately report FMV 0/null
                            for an edition with no snapshot; dividing by that
                            yielded Infinity and always painted an ↑. */}
                        {deal.aspUsd !== null && deal.aspUsd > 0 && (() => {
                          const diff = safeRatioDiff(deal.aspUsd, deal.baseFmv);
                          if (diff === null) return null;
                          if (Math.abs(diff) < 0.1) return null;
                          return diff > 0
                            ? <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-success)" }} title={`Avg sales price $${fmt(deal.aspUsd)} — trending up`}>↑</span>
                            : <span style={{ fontSize: "var(--text-xs)", color: "var(--rpc-danger)" }} title={`Avg sales price $${fmt(deal.aspUsd)} — trending down`}>↓</span>;
                        })()}
                      </div>
                      {deal.serialMult > 1 && (
                        <div style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)" }}>
                          base {fmvDisplay(deal.baseFmv)} × {deal.serialMult.toFixed(2)}
                        </div>
                      )}
                      {deal.serialFmvEstimate ? (
                        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 2 }}>
                          <SerialFmvBadge data={deal.serialFmvEstimate} />
                        </div>
                      ) : null}
                    </td>

                    {/* Discount */}
                    <td style={{ padding: "8px 12px", textAlign: "right" }}>
                      {deal.lowConfidenceFmv ? (
                        <span
                          title="FMV here is averaged over very few, wide-ranging sales, so it overshoots the typical price — this discount is uncertain. Check recent sales before acting."
                          style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--rpc-warning)", letterSpacing: "0.02em", whiteSpace: "nowrap" }}
                        >
                          ⚠ thin data
                        </span>
                      ) : (
                        <span className="inline-block px-2 py-0.5 rounded-full text-xs font-bold" style={{ fontFamily: "var(--font-mono)", ...discountColor(deal.discount) }}>
                          {deal.discount > 0 ? `-${fmt(deal.discount, 1)}%` : "~0%"}
                        </span>
                      )}
                      {deal.netOfFees ? (
                        <div style={{ marginTop: 2 }}>
                          <NetOfFeesNote net={deal.netOfFees} />
                        </div>
                      ) : null}
                    </td>

                    {/* Action */}
                    <td style={{ padding: "8px 12px" }} onClick={(e) => e.stopPropagation()}>
                      <ActionCell deal={deal} accent={accent} collectionSlug={feedCollection} />
                    </td>
                  </tr>
                  {/* Task 2: Edition depth panel */}
                  {expandedFlowId === deal.flowId && (
                    <tr style={{ borderBottom: "1px solid var(--rpc-border)", background: "var(--rpc-surface)" }}>
                      <td colSpan={8} style={{ padding: "8px 16px" }}>
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
                                {/* ⚠ Conditional, like BEST FLOOR and LT FMV below — NOT unconditional.
                                    /api/edition-floor no longer reports a Flowty floor: that leg took a
                                    setID/playID and used neither, returning the cheapest TopShot listing
                                    on Flowty ANYWHERE as this edition's floor, so it was removed rather
                                    than repaired. Rendered unconditionally this chip now reads
                                    "FLOWTY — (0 listed)" on every expansion, which claims we checked
                                    Flowty for this edition and found nothing — we do not check it at all.
                                    Absent is honest; "0 listed" is a measurement we never took. */}
                                {(depthFloor.flowtyFloor != null || depthFloor.flowtyListingCount > 0) && (
                                  <div className="rpc-chip" style={{ display: "flex", alignItems: "center", gap: 6, borderColor: "rgba(59,130,246,0.3)" }}>
                                    <span style={{ fontSize: 9, color: "var(--rpc-info)", letterSpacing: "0.08em" }}>FLOWTY</span>
                                    <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", color: "var(--rpc-text-primary)", fontWeight: 600 }}>
                                      {depthFloor.flowtyFloor != null ? `$${fmt(depthFloor.flowtyFloor)}` : "—"}
                                    </span>
                                    <span style={{ fontSize: 9, color: "var(--rpc-text-ghost)" }}>({depthFloor.flowtyListingCount} listed)</span>
                                  </div>
                                )}
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
                            {depthListingsError ? (
                              // Must precede the length check: a failed read
                              // leaves the list empty, so testing emptiness
                              // first swallows the failure silently.
                              <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-ghost)", padding: "4px 0" }}>{depthListingsError}</div>
                            ) : depthDeals.length === 0 ? (
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
          <span>Avg sales price trending up &nbsp;</span>
          <span style={{ color: "var(--rpc-danger)" }}>↓</span>
          <span>Avg sales price trending down</span>
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
          ) : suggestionsState_ === "read-failed" ? (
            /* ⚠ BEFORE the conclusion below. "Your moments are priced at or
               below current market asks" is a specific analytical claim about
               the reader's own portfolio, and it is actionable in the direction
               of INACTION — it tells them not to re-list. */
            <div role="status" className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
              Couldn&rsquo;t read your collection, so there&rsquo;s nothing to compare against yet. This says
              nothing about how your Moments are priced.
            </div>
          ) : suggestionsState_ === "no-market" ? (
            <div role="status" className="rpc-mono" style={{ color: "var(--rpc-text-muted)", fontSize: "var(--text-sm)" }}>
              Waiting on the live listings feed — suggestions compare your Moments against it.
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
          editionKey: selectedDeal.editionKey ?? null,
        } : null}
        collectionUrlSlug={collectionSlug}
        marketplaceSource={selectedDeal?.source === "flowty" ? "flowty" : "topshot"}
        dapperUrl={selectedDeal ? resolveDapperUrl(selectedDeal, feedCollection) : null}
        onClose={() => setSelectedDeal(null)}
      />
    </div>
  );
}

// ── Sniper section (Moments | Packs sub-toggle) ─────────────────────────
// After the 2026-07-18 IA reorg the Sniper tab carries a Moments|Packs
// sub-toggle for Top Shot + NFL All Day (the two collections with sealed-pack
// deal data). Moments is the existing deal feed (<SniperMomentsBody/>); Packs
// mounts <PackSniperClient/> locked to this collection (it self-fetches its own
// deals on mount, so no server pre-fetch is needed here). Other collections
// render Moments-only with no sub-nav.
export default function SniperClient() {
  const routeParams = useParams();
  const collectionSlug = routeParams.collection as string;
  const collectionObj = getCollection(collectionSlug);
  const accent = collectionObj?.accent ?? "var(--rpc-red)";
  const searchParams = useSearchParams();
  const section = subSectionFromParams(searchParams);
  const hasPacks = collectionSlug === "nba-top-shot" || collectionSlug === "nfl-all-day";
  const packsActive = hasPacks && section === "packs";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {hasPacks && (
        <div style={{ display: "flex" }}>
          <PackSubNav accent={accent} active={packsActive ? "packs" : "moments"} />
        </div>
      )}
      {packsActive ? (
        <PackSniperClient
          lockedCollection={collectionSlug as "nba-top-shot" | "nfl-all-day"}
          initialDeals={[]}
          initialFetchedAt={null}
        />
      ) : (
        <SniperMomentsBody />
      )}
    </div>
  );
}
