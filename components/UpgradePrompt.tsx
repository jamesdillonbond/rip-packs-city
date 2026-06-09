"use client"
// components/UpgradePrompt.tsx
//
// Inline upgrade prompt that surfaces below blocked features. Triggered
// from any 402 / daily_limit_reached / plan_limit_reached response or
// rendered preemptively next to a Pro-only surface.
//
// Two variants:
//   - "compact"  — single-line "Upgrade for more" with a CTA link. Use
//                  inline beside form errors and quota warnings.
//   - "full"     — card with feature list and CTA. Use as a section block
//                  on quota-exceeded surfaces.

import Link from "next/link"
import type { CSSProperties } from "react"

type Variant = "compact" | "full"

const COMPACT_WRAP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "var(--rpc-red-bg, rgba(224,58,47,0.08))",
  border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.3))",
  borderRadius: "var(--radius-sm, 6px)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-secondary)",
  letterSpacing: "0.04em",
}

const COMPACT_CTA: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 11,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-red, #E03A2F)",
  textDecoration: "none",
}

const FULL_CARD: CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.4))",
  borderRadius: "var(--radius-lg, 12px)",
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 14,
  fontFamily: "var(--font-mono)",
  color: "var(--rpc-text-secondary)",
}

const FULL_HEADER: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 18,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
}

const FEATURE_LIST: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  lineHeight: 1.6,
}

const FULL_CTA: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--rpc-red, #E03A2F)",
  color: "#fff",
  padding: "10px 18px",
  borderRadius: "var(--radius-sm, 6px)",
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 12,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  textDecoration: "none",
  alignSelf: "flex-start",
}

const DEFAULT_PRO_FEATURES = [
  "Unlimited saved wallets",
  "200 AI Concierge messages per day",
  "Real-time sniper feed (30-sec refresh)",
  "Insider Signals — institutional flow tracking",
  "25 custom alerts (price drops, listing alerts)",
  "Pack EV with confidence intervals",
]

export default function UpgradePrompt({
  variant = "compact",
  message,
  features,
  ctaLabel = "See plans",
  upgradeUrl = "/pricing",
  headline = "Unlock RPC Pro",
}: {
  variant?: Variant
  message?: string
  features?: string[]
  ctaLabel?: string
  upgradeUrl?: string
  headline?: string
}) {
  if (variant === "compact") {
    return (
      <div style={COMPACT_WRAP} role="note">
        <span>{message ?? "You've hit a free-plan limit."}</span>
        <Link href={upgradeUrl} style={COMPACT_CTA}>
          {ctaLabel} →
        </Link>
      </div>
    )
  }

  const items = features ?? DEFAULT_PRO_FEATURES
  return (
    <div style={FULL_CARD} role="region" aria-label="RPC Pro upgrade">
      <div style={FULL_HEADER}>{headline}</div>
      {message && <div style={{ fontSize: 13, lineHeight: 1.6 }}>{message}</div>}
      <ul style={FEATURE_LIST}>
        {items.map(f => (<li key={f}>{f}</li>))}
      </ul>
      <Link href={upgradeUrl} style={FULL_CTA}>{ctaLabel}</Link>
    </div>
  )
}
