"use client"
// components/PlanBadge.tsx
//
// Small badge rendered next to a profile/avatar showing the user's tier.
// Founding gets a gold accent; every other Pro tier gets brand red.
// Free is intentionally absent (no "Free" badge — that just draws
// attention to the limitation). Server-side callers get the user's plan
// via lib/pro-tier.getUserPlan(walletAddress); this component renders
// only when a non-free plan is present.

import type { CSSProperties } from "react"

export type PlanForBadge =
  | "founding"
  | "moments_payment"
  | "pro_grandfather"
  | "pro_paid"
  | "pro_trial"
  | "admin"
  | "free"

const LABELS: Record<PlanForBadge, string> = {
  founding: "Founding",
  moments_payment: "Pro",
  pro_grandfather: "Pro",
  pro_paid: "Pro",
  pro_trial: "Pro Trial",
  admin: "Admin",
  free: "",
}

const BASE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  fontFamily: "var(--font-display, 'Barlow Condensed'), sans-serif",
  fontWeight: 800,
  fontSize: 9,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  padding: "2px 7px",
  borderRadius: 999,
  lineHeight: 1.4,
}

const FOUNDING: CSSProperties = {
  ...BASE,
  background: "rgba(255, 200, 87, 0.12)",
  border: "1px solid rgba(255, 200, 87, 0.4)",
  color: "var(--rpc-gold, #FFC857)",
}

const PRO: CSSProperties = {
  ...BASE,
  background: "var(--rpc-red-bg, rgba(224,58,47,0.1))",
  border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.3))",
  color: "var(--rpc-red, #E03A2F)",
}

const ADMIN: CSSProperties = {
  ...BASE,
  background: "rgba(96, 165, 250, 0.12)",
  border: "1px solid rgba(96, 165, 250, 0.4)",
  color: "#60A5FA",
}

export default function PlanBadge({ plan }: { plan: PlanForBadge }) {
  if (plan === "free") return null
  const label = LABELS[plan] ?? "Pro"
  const style =
    plan === "founding" ? FOUNDING :
    plan === "admin" ? ADMIN :
    PRO
  return <span style={style} aria-label={`Account tier: ${label}`}>{label}</span>
}
