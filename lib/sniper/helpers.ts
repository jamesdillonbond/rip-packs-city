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
