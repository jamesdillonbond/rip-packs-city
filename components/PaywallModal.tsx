"use client"
// components/PaywallModal.tsx
//
// Modal version of UpgradePrompt for full feature blocks (Insider Signals,
// Pack EV with depletion, etc). Accepts a `featureName` so the headline
// reads "Unlock {featureName} — RPC Pro" instead of the generic copy.
//
// Backdrop is the heavy 85%-opaque + backdrop-blur-md pattern Trevor
// already uses elsewhere (the lighter modal backdrop bled through and
// looked unfinished — see the FirstRunTour spec in Prompt 4 for the same
// pattern, kept in sync here).

import { useEffect } from "react"
import Link from "next/link"
import type { CSSProperties } from "react"

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 80,
  background: "rgba(0, 0, 0, 0.85)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
}

const CARD: CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.4))",
  borderRadius: "var(--radius-lg, 12px)",
  padding: 28,
  maxWidth: 480,
  width: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  fontFamily: "var(--font-mono)",
  color: "var(--rpc-text-secondary)",
  position: "relative",
}

const HEADLINE: CSSProperties = {
  fontFamily: "var(--font-display, 'Barlow Condensed'), sans-serif",
  fontWeight: 900,
  fontSize: 24,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: 0,
  paddingRight: 36,
}

const SUBTITLE: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.6,
}

const FEATURE_LIST: CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  fontSize: 12,
  lineHeight: 1.6,
}

const CTA: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--rpc-red, #E03A2F)",
  color: "#fff",
  padding: "12px 22px",
  borderRadius: "var(--radius-sm, 6px)",
  fontFamily: "var(--font-display, 'Barlow Condensed'), sans-serif",
  fontWeight: 800,
  fontSize: 13,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  textDecoration: "none",
  alignSelf: "stretch",
}

const SECONDARY: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--rpc-text-muted)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
  alignSelf: "center",
  padding: "8px 12px",
}

const CLOSE: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  background: "transparent",
  border: "none",
  color: "var(--rpc-text-muted)",
  cursor: "pointer",
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 18,
  lineHeight: 1,
}

const CHECK: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
}

const DEFAULT_FEATURES = [
  "Unlimited saved wallets",
  "200 AI Concierge messages per day",
  "Real-time sniper feed (30-sec refresh)",
  "Insider Signals — institutional flow tracking",
  "25 custom alerts (price drops, listing alerts)",
]

export default function PaywallModal({
  open,
  onClose,
  featureName,
  description,
  features,
  ctaLabel = "Unlock with RPC Pro",
  secondaryLabel = "Maybe later",
  upgradeUrl = "/pricing",
}: {
  open: boolean
  onClose: () => void
  featureName: string
  description?: string
  features?: string[]
  ctaLabel?: string
  secondaryLabel?: string
  upgradeUrl?: string
}) {
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null
  const items = features ?? DEFAULT_FEATURES

  return (
    <div
      style={BACKDROP}
      role="dialog"
      aria-modal="true"
      aria-labelledby="paywall-modal-headline"
      onClick={onClose}
    >
      <div style={CARD} onClick={e => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close upgrade prompt" style={CLOSE}>×</button>
        <h2 id="paywall-modal-headline" style={HEADLINE}>
          Unlock {featureName} — RPC Pro
        </h2>
        {description && <p style={SUBTITLE}>{description}</p>}
        <ul style={FEATURE_LIST}>
          {items.map(f => (
            <li key={f} style={CHECK}>
              <span aria-hidden style={{ color: "var(--rpc-red, #E03A2F)" }}>✓</span>
              <span>{f}</span>
            </li>
          ))}
        </ul>
        <Link href={upgradeUrl} style={CTA}>{ctaLabel}</Link>
        <button onClick={onClose} style={SECONDARY}>{secondaryLabel}</button>
      </div>
    </div>
  )
}
