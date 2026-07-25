// lib/sniper/helpers.ts
//
// Pure helpers + small color/label lookups for the collection sniper page,
// extracted verbatim in the Phase 1 structural refactor of
// app/(collections)/[collection]/sniper/page.tsx. No logic changes.

import type { CSSProperties } from "react";
import { marketplaceMomentUrl, dapperMarketMomentUrl } from "@/lib/collections";
import { PINNACLE_VARIANT_COLORS, PINNACLE_VARIANT_LABELS } from "@/lib/pinnacle/pinnacleTypes";
import { trackOutboundClick } from "@/lib/track-click";
import type { SniperDeal } from "./types";

// P2.5 — a deal is "verified" when its FMV is backed by real recent sales
// (HIGH/MEDIUM confidence) and was NOT thin-data-clamped or ask-fallback.
// Thin/LOW/ASK_ONLY editions produce the fake "-91% off" bargains (old high
// sales over-weight the WAP on thin editions), so they're excluded from the
// headline "hot"/avg-discount stats and demoted below verified deals — the
// same HIGH+MED gate /insights/deals already applies. Not deleted: with the
// Verified-FMV-only toggle off they still render, flagged, at the bottom.
export function isVerifiedDeal(d: SniperDeal): boolean {
  const c = (d.confidence ?? "").toLowerCase();
  return (c === "high" || c === "medium") &&
    d.lowConfidenceFmv !== true &&
    d.confidenceSource !== "ask_fallback";
}

// ─── Deal list shaping (filter / demote / stats) ──────────────────────────────
//
// Extracted verbatim from the sniper page's render body so the filter predicate,
// the verified-first demotion, and the headline stats can be unit-tested without
// mounting the 1,700-line client component. No logic changes.

export type OwnedFilter = "all" | "owned" | "not-owned";

export interface SniperDealFilterOpts {
  /** free-text query matched (case-insensitive) against player/set/team */
  search?: string | null;
  /** Verified-FMV-only toggle — hides thin/LOW/ASK_ONLY/clamped deals */
  showVerifiedOnly?: boolean;
  /** owned / not-owned gating; "all" is a no-op */
  ownedFilter?: OwnedFilter;
  /** the viewer's owned edition keys (both int-pair and legacy uuid keys) */
  ownedIds?: Set<string>;
}

/** Does the viewer own the edition this deal is for? Checks both key forms. */
export function isDealOwned(d: SniperDeal, ownedIds: Set<string>): boolean {
  return (
    (!!d.intEditionKey && ownedIds.has(d.intEditionKey)) ||
    (!!d.editionKey && ownedIds.has(d.editionKey))
  );
}

// The visibleDeals filter: drop negative-discount rows, apply the search box,
// the Verified-only toggle, and the owned/not-owned gate. Returns a NEW array.
export function filterSniperDeals(deals: SniperDeal[], opts: SniperDealFilterOpts = {}): SniperDeal[] {
  const { search, showVerifiedOnly, ownedFilter = "all", ownedIds } = opts;
  const q = search ? search.toLowerCase() : null;
  return deals.filter((d) => {
    if (d.discount < 0) return false;
    if (q) {
      if (
        !d.playerName.toLowerCase().includes(q) &&
        !d.setName.toLowerCase().includes(q) &&
        !d.teamName.toLowerCase().includes(q)
      )
        return false;
    }
    if (showVerifiedOnly && !isVerifiedDeal(d)) return false;
    if (ownedFilter !== "all") {
      const owned = isDealOwned(d, ownedIds ?? new Set());
      if (ownedFilter === "owned" && !owned) return false;
      if (ownedFilter === "not-owned" && owned) return false;
    }
    return true;
  });
}

// Stable demotion of thin/low-confidence deals below verified ones, so real
// deals lead when the Verified-only toggle is off. Returns a NEW sorted array
// (Array.prototype.sort is stable, so within each group the input order — the
// API's sort — is preserved).
export function sortByVerifiedFirst(deals: SniperDeal[]): SniperDeal[] {
  return [...deals].sort((a, b) => Number(!isVerifiedDeal(a)) - Number(!isVerifiedDeal(b)));
}

export interface SniperStats {
  total: number;
  hot: number;
  badge: number;
  special: number;
  avgDiscount: number;
}

// Headline stats. "hot" (discount>=40) and avgDiscount are computed over the
// VERIFIED subset only, so the top-of-page numbers can't be inflated by thin-FMV
// fake bargains; `total`/`badge`/`special` reflect the full visible set.
export function computeSniperStats(visibleDeals: SniperDeal[]): SniperStats {
  const verified = visibleDeals.filter(isVerifiedDeal);
  return {
    total: visibleDeals.length,
    hot: verified.filter((d) => d.discount >= 40).length,
    badge: visibleDeals.filter((d) => d.hasBadge).length,
    special: visibleDeals.filter((d) => d.isSpecialSerial).length,
    avgDiscount:
      verified.length > 0 ? verified.reduce((s, d) => s + d.discount, 0) / verified.length : 0,
  };
}

// ─── Click tracking helper ────────────────────────────────────────────────────

export function trackClick(deal: SniperDeal, walletAddress: string | null) {
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
export function resolveViewUrl(deal: SniperDeal, collectionSlug: string): string | null {
  const url = deal.buyUrl?.trim();
  // Reject dead links before returning them: Flowty (marketplace shut down
  // 2026-05) and the TopShot `listings/p2p?editionFlowID=<setID:playID>` form
  // the get_topshot_sniper_deals RPC builds — that param carries setID:playID,
  // NOT TopShot's numeric edition flowID, so the page can't resolve the edition
  // and the link goes nowhere. Serial-level GQL rows already carry a good
  // `nbatopshot.com/moment/<flowId>` buyUrl and pass straight through.
  const isDead =
    !url ||
    url.includes("flowty.io") ||
    url.includes("editionFlowID=") ||
    url.includes("/listings/p2p");
  if (url && !isDead) return url;
  // Fall back to the native moment page only when we hold a real numeric moment
  // id (serial-level rows). Edition-level RPC rows put a setID:playID key in
  // momentId, which would just mint another broken URL — return null so the
  // action cell renders "—" instead of a dead link.
  if (deal.momentId && /^\d+$/.test(deal.momentId)) {
    return marketplaceMomentUrl(collectionSlug, deal.momentId);
  }
  return null;
}

// Second-marketplace (dapper.market) link rendered alongside the native one.
// dapper deep-links need a REAL on-chain moment id, not an edition key — so we
// return null (skip the link) for edition-level deals rather than mint a wrong
// one. TopShot real listings carry the moment id in momentId (plain integer);
// the TS edition-level RPC augment puts a setID:playID key there. AllDay carries
// the edition id in momentId and the real moment id in flowId, but only when the
// two differ (edition-level AllDay deals set flowId === momentId).
export function resolveDapperUrl(deal: SniperDeal, collectionSlug: string): string | null {
  let momentId: string | null = null;
  if (deal.source === "allday") {
    momentId = deal.flowId && deal.flowId !== deal.momentId ? deal.flowId : null;
  } else {
    momentId = deal.momentId && /^\d+$/.test(deal.momentId) ? deal.momentId : null;
  }
  return dapperMarketMomentUrl(collectionSlug, momentId);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function timeAgo(iso: string | null): string {
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

export function fmt(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Render a fair-value figure, or an honest em-dash when there isn't one.
//
// Feeds are allowed to report "we do not know this edition's FMV" (null), and a
// snapshot of 0 means the same thing in practice — no sales, nothing to value.
// Printing "$0.00" reads like a real price of zero, and a substituted number
// (e.g. borrowing the ask) is worse. An em-dash is always correct when the data
// is absent. (2026-07-25 — companion to the feed-side null-FMV fixes.)
export function fmvDisplay(v: number | null | undefined, decimals = 2): string {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? `$${fmt(v, decimals)}` : "—";
}

// Safe percentage-change denominator. `(a - b) / b` with b = 0/null yields
// Infinity or NaN, which the sniper board turned into a permanent "trending up"
// arrow. Returns null when no honest ratio exists.
export function safeRatioDiff(numerator: number | null | undefined, base: number | null | undefined): number | null {
  if (typeof numerator !== "number" || !Number.isFinite(numerator)) return null;
  if (typeof base !== "number" || !Number.isFinite(base) || base <= 0) return null;
  return (numerator - base) / base;
}

export function tierColor(tier: string): string {
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

export function allDayTierColor(tier: string): string {
  return ALLDAY_TIER_COLORS[tier?.toUpperCase()] ?? "#94A3B8";
}

export function resolveTierColor(tier: string, isAllDay: boolean): string {
  return isAllDay ? allDayTierColor(tier) : tierColor(tier);
}

export function variantColor(variant: string): string {
  return PINNACLE_VARIANT_COLORS[variant] ?? "#9CA3AF";
}

export function variantLabel(variant: string): string {
  return PINNACLE_VARIANT_LABELS[variant] ?? variant;
}

export function holoClass(tier: string): string {
  switch (tier.toUpperCase()) {
    case "LEGENDARY": return "rpc-holo-legendary";
    case "ULTIMATE":  return "rpc-holo-ultimate";
    case "RARE":      return "rpc-holo-rare";
    default:          return "";
  }
}

export function discountColor(pct: number): CSSProperties {
  if (pct >= 50) return { background: "rgba(239,68,68,0.2)", color: "rgb(252,165,165)", border: "1px solid rgba(239,68,68,0.4)" };
  if (pct >= 30) return { background: "rgba(249,115,22,0.2)", color: "rgb(253,186,116)", border: "1px solid rgba(249,115,22,0.4)" };
  if (pct >= 15) return { background: "rgba(234,179,8,0.2)", color: "rgb(253,224,71)", border: "1px solid rgba(234,179,8,0.4)" };
  if (pct >= 5)  return { background: "rgba(16,185,129,0.2)", color: "rgb(110,231,183)", border: "1px solid rgba(16,185,129,0.4)" };
  return { border: "1px solid var(--rpc-border)" };
}
