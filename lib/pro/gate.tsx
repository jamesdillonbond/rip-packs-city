// lib/pro/gate.tsx
// Stub for RPC Pro subscription gating.
// Scaffolding only — no Stripe integration, no routes, no UI changes.

import React from "react"

/** Features available in the Pro tier. */
export const PRO_FEATURES = {
  sniper_unlimited: true,
  fmv_export: true,
  deal_alerts: true,
} as const

type ProGateProps = {
  children: React.ReactNode
  /** The Pro feature key this gate protects. */
  feature: string
}

/**
 * Wraps children behind a Pro subscription check.
 * Currently renders children unconditionally.
 */
export function ProGate({ children }: ProGateProps) {
  // TODO: wire Stripe subscription check
  return <>{children}</>
}
