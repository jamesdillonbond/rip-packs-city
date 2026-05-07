"use client"
// components/legal/FmvDisclaimer.tsx
//
// Unified "FMV is not investment advice" disclosure that lives wherever
// pricing is surfaced. Two shapes:
//   - "short" (default): single-line "For informational purposes — not
//     investment advice" with an info icon and a "How is FMV calculated?"
//     link to /legal/fmv-methodology.
//   - "full": expanded paragraph describing the methodology caveat.
//     Used in tooltip / footer / disclosure panel contexts.
//
// The link target is the FMV methodology page (Prompt 13 Part F). Both
// variants stay in the brand system (var(--rpc-text-muted), var(--font-mono),
// no hardcoded colors).

import Link from "next/link"
import type { CSSProperties } from "react"

type Variant = "short" | "full"

const SHORT_WRAP: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--rpc-text-muted)",
  letterSpacing: "0.04em",
  lineHeight: 1.5,
}

const ICON: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  borderRadius: 999,
  border: "1px solid var(--rpc-text-muted)",
  fontSize: 9,
  fontFamily: "var(--font-display, 'Barlow Condensed'), sans-serif",
  fontWeight: 800,
  flexShrink: 0,
}

const LINK: CSSProperties = {
  color: "var(--rpc-text-muted)",
  textDecoration: "underline",
  textDecorationStyle: "dotted",
  textDecorationColor: "rgba(255,255,255,0.2)",
}

const FULL_WRAP: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--rpc-text-secondary)",
  lineHeight: 1.7,
  padding: 12,
  background: "rgba(255,255,255,0.03)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-md, 8px)",
  maxWidth: 520,
}

export default function FmvDisclaimer({
  variant = "short",
  className,
  showMethodologyLink = true,
}: {
  variant?: Variant
  className?: string
  showMethodologyLink?: boolean
}) {
  if (variant === "full") {
    return (
      <div style={FULL_WRAP} className={className}>
        FMV values are derived from observed marketplace activity and are estimates only.
        They do not constitute investment advice. Marketplaces are volatile and past prices
        do not predict future prices.
        {showMethodologyLink && (
          <>
            {" "}
            <Link href="/legal/fmv-methodology" style={LINK}>
              How is FMV calculated?
            </Link>
          </>
        )}
      </div>
    )
  }

  return (
    <span style={SHORT_WRAP} className={className}>
      <span aria-hidden style={ICON}>i</span>
      <span>For informational purposes — not investment advice.</span>
      {showMethodologyLink && (
        <Link href="/legal/fmv-methodology" style={LINK}>
          How is FMV calculated?
        </Link>
      )}
    </span>
  )
}
