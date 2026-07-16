// components/marketplace-status/MarketplaceStatusBanner.tsx
//
// Top-of-page banner shown on /[collection]/overview when the collection's
// marketplace is in a non-healthy state. Copy varies per status:
//   shutdown → hard sunset language (UFC migrated to Aptos)
//   unknown  → softer "investigating venue" tone (Golazos)
//   dormant / degraded → generic informational variant
//
// Healthy collections render nothing.

"use client"

import { useMarketplaceStatus } from "./useMarketplaceStatus"

interface Props {
  /** Hyphen slug (e.g. "ufc", "laliga-golazos"). */
  collectionSlug: string
}

function bannerCopy(slug: string, status: string, notes: string | null): {
  title: string
  body: string
  accent: string
  background: string
  border: string
} | null {
  if (status === "shutdown") {
    if (slug === "ufc") {
      return {
        title: "UFC Strike has no active Flow marketplace",
        body:
          "UFC Strike is migrating to the Aptos blockchain; Flow trading has been frozen since May 2026. Everything below is historical Flow data — buy flows are disabled on Flow.",
        accent: "var(--rpc-red)",
        background: "rgba(224,58,47,0.08)",
        border: "rgba(224,58,47,0.35)",
      }
    }
    return {
      title: "Marketplace shut down",
      body:
        notes ??
        "This collection no longer has an active Flow marketplace. Historical data remains accessible; buy flows are disabled.",
      accent: "var(--rpc-red)",
      background: "rgba(224,58,47,0.08)",
      border: "rgba(224,58,47,0.35)",
    }
  }
  if (status === "unknown") {
    if (slug === "laliga-golazos") {
      return {
        title: "No confirmed Flow marketplace",
        body:
          "We haven't identified an active Flow marketplace for Golazos, so buy flows are disabled. Portfolio and FMV tools below still work normally.",
        accent: "#F59E0B",
        background: "rgba(245,158,11,0.08)",
        border: "rgba(245,158,11,0.35)",
      }
    }
    return {
      title: "Marketplace status uncertain",
      body:
        notes ??
        "We haven't confirmed an active marketplace venue, so buy flows are disabled. Other tools still work normally.",
      accent: "#F59E0B",
      background: "rgba(245,158,11,0.08)",
      border: "rgba(245,158,11,0.35)",
    }
  }
  if (status === "dormant" || status === "degraded") {
    return {
      title: status === "dormant" ? "Marketplace dormant" : "Marketplace degraded",
      body:
        notes ??
        "Trade activity has slowed significantly. Buy flows remain enabled but listings may be sparse.",
      accent: "#F59E0B",
      background: "rgba(245,158,11,0.06)",
      border: "rgba(245,158,11,0.25)",
    }
  }
  return null
}

// Positive, time-boxed informational notices. Unlike bannerCopy these render
// even when the marketplace is "healthy" — they surface a buy-side incentive,
// not a warning, so they use a calm green accent (never the amber/red warning
// palette). Each notice self-expires past its window so no stale promo lingers.
function infoNotice(slug: string): {
  title: string
  body: string
  accent: string
  background: string
  border: string
} | null {
  // NFL All Day 5% Dapper Balance rebate window — ends 2026-09-09 (shown
  // through the end of that day). Source: NFL All Day marketplace changes.
  if (slug === "nfl-all-day" && Date.now() < Date.parse("2026-09-10T00:00:00Z")) {
    return {
      title: "AllDay buys earn a 5% rebate through Sep 9",
      body:
        "NFL All Day marketplace purchases made through September 9, 2026 earn a 5% Dapper Balance rebate — credited after a 12-month hold on the purchased Moment — plus Founding Collector status. Details at NFL All Day.",
      accent: "#10B981",
      background: "rgba(16,185,129,0.07)",
      border: "rgba(16,185,129,0.30)",
    }
  }
  return null
}

export default function MarketplaceStatusBanner({ collectionSlug }: Props) {
  const { status, loaded } = useMarketplaceStatus(collectionSlug)
  if (!loaded || !status) return null
  // A non-healthy venue warning takes precedence; otherwise fall back to a
  // positive, time-boxed info notice (which is allowed to show when healthy).
  const warning =
    status.status === "healthy"
      ? null
      : bannerCopy(collectionSlug, status.status, status.notes)
  const copy = warning ?? infoNotice(collectionSlug)
  if (!copy) return null

  return (
    <section
      role="status"
      aria-live="polite"
      className="rpc-card"
      style={{
        padding: "12px 16px",
        background: copy.background,
        border: "1px solid " + copy.border,
        borderLeft: "3px solid " + copy.accent,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: "var(--text-base)",
          color: copy.accent,
          letterSpacing: "0.04em",
          marginBottom: 4,
          textTransform: "uppercase",
        }}
      >
        {copy.title}
      </div>
      <div
        className="rpc-mono"
        style={{
          fontSize: "var(--text-xs)",
          color: "var(--rpc-text-secondary)",
          lineHeight: 1.6,
        }}
      >
        {copy.body}
      </div>
    </section>
  )
}
