// components/entity/_shared.tsx
// Phase 1A/1B/1C/1D/1E/1F.
// Server-safe formatting and tiny presentational helpers used across every
// entity detail page (edition, set, player, team, series). Keep this file
// free of "use client" directives — anything client-only lives in its own
// component.

import Link from "next/link"
import type { ReactNode } from "react"

export const EM_DASH = "—"

// ── Formatters ──────────────────────────────────────────────────────────────

export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH
  if (value === 0) return EM_DASH
  if (value >= 100) {
    return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })
  }
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH
  return value.toLocaleString("en-US")
}

export function fmtPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EM_DASH
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(digits)}%`
}

/** Wallet address: lowercase, 0x prefix, truncated to 0x1234…abcd. */
export function truncWallet(addr: string | null | undefined): string {
  if (!addr) return EM_DASH
  const lower = addr.toLowerCase()
  const prefixed = lower.startsWith("0x") ? lower : `0x${lower}`
  if (prefixed.length <= 12) return prefixed
  return `${prefixed.slice(0, 6)}…${prefixed.slice(-4)}`
}

/** Compact relative time. Uses Intl.RelativeTimeFormat. */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return EM_DASH
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return EM_DASH
  const diffSec = Math.round((t - now) / 1000)
  const abs = Math.abs(diffSec)
  const fmt = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" })
  if (abs < 60) return fmt.format(diffSec, "second")
  if (abs < 3600) return fmt.format(Math.round(diffSec / 60), "minute")
  if (abs < 86400) return fmt.format(Math.round(diffSec / 3600), "hour")
  if (abs < 86400 * 30) return fmt.format(Math.round(diffSec / 86400), "day")
  if (abs < 86400 * 365) return fmt.format(Math.round(diffSec / (86400 * 30)), "month")
  return fmt.format(Math.round(diffSec / (86400 * 365)), "year")
}

// ── Tier badge ──────────────────────────────────────────────────────────────

const TIER_VAR_MAP: Record<string, { fg: string; bg: string; bd: string }> = {
  ULTIMATE:    { fg: "var(--tier-ultimate)",   bg: "var(--tier-ultimate-bg)",   bd: "var(--tier-ultimate-border)" },
  LEGENDARY:   { fg: "var(--tier-legendary)",  bg: "var(--tier-legendary-bg)",  bd: "var(--tier-legendary-border)" },
  CHAMPION:    { fg: "var(--tier-champion)",   bg: "var(--tier-champion-bg)",   bd: "var(--tier-champion-border)" },
  CHALLENGER:  { fg: "var(--tier-challenger)", bg: "var(--tier-challenger-bg)", bd: "var(--tier-challenger-border)" },
  CONTENDER:   { fg: "var(--tier-contender)",  bg: "var(--tier-contender-bg)",  bd: "var(--tier-contender-border)" },
  RARE:        { fg: "var(--tier-rare)",       bg: "var(--tier-rare-bg)",       bd: "var(--tier-rare-border)" },
  UNCOMMON:    { fg: "var(--tier-uncommon)",   bg: "var(--tier-uncommon-bg)",   bd: "var(--tier-uncommon-border)" },
  FANDOM:      { fg: "var(--tier-fandom)",     bg: "var(--tier-fandom-bg)",     bd: "var(--tier-fandom-border)" },
  COMMON:      { fg: "var(--tier-common)",     bg: "var(--tier-common-bg)",     bd: "var(--tier-common-border)" },
}

const GRAY_FALLBACK = { fg: "var(--rpc-text-secondary)", bg: "rgba(255,255,255,0.04)", bd: "rgba(255,255,255,0.12)" }

export function TierBadge({ tier, label }: { tier: string | null | undefined; label?: string }) {
  if (!tier) return null
  const key = tier.toUpperCase()
  const colors = TIER_VAR_MAP[key] ?? GRAY_FALLBACK
  const text = label ?? tier
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      letterSpacing: "0.12em",
      textTransform: "uppercase",
      color: colors.fg,
      background: colors.bg,
      border: `1px solid ${colors.bd}`,
    }}>{text}</span>
  )
}

// ── Confidence pill ─────────────────────────────────────────────────────────

const CONFIDENCE_COLORS: Record<string, { fg: string; bg: string; bd: string }> = {
  HIGH:      { fg: "#34D399", bg: "rgba(52,211,153,0.10)", bd: "rgba(52,211,153,0.30)" },
  MEDIUM:    { fg: "#F59E0B", bg: "rgba(245,158,11,0.10)", bd: "rgba(245,158,11,0.30)" },
  LOW:       { fg: "#94A3B8", bg: "rgba(148,163,184,0.10)", bd: "rgba(148,163,184,0.30)" },
  ASK_ONLY:  { fg: "#3B82F6", bg: "rgba(59,130,246,0.10)", bd: "rgba(59,130,246,0.30)" },
  // STALE = fmv_snapshots.confidence after the thin-sales guard
  // downgraded an edition with no sales in 30+ days. Muted/desaturated
  // intentionally so the badge reads as "not actively backed" instead
  // of competing with HIGH/MEDIUM/LOW for visual weight.
  STALE:     { fg: "#9CA3AF", bg: "rgba(107,114,128,0.08)", bd: "rgba(107,114,128,0.25)" },
}

const STALE_TOOLTIP = "No sales in 30+ days — FMV may be inaccurate"

/** Canonical methodology explainer; the confidence chip links here. */
export const FMV_METHODOLOGY_HREF = "/legal/fmv-methodology"

// When `href` is supplied (default = FMV_METHODOLOGY_HREF) the pill becomes a
// link to the methodology page so a LOW / ASK_ONLY / STALE chip is one click
// from "what does this mean?". Pass href={null} on any surface where the pill
// already sits INSIDE another <a>/<Link> (e.g. a full-card edition tile) to
// avoid an invalid nested anchor.
export function ConfidencePill({
  confidence,
  href = FMV_METHODOLOGY_HREF,
}: {
  confidence: string | null | undefined
  href?: string | null
}) {
  if (!confidence || confidence === "NONE") {
    return <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.08em" }}>no FMV</span>
  }
  const key = confidence.toUpperCase()
  const colors = CONFIDENCE_COLORS[key] ?? GRAY_FALLBACK
  const isStale = key === "STALE"
  const pill = (
    <span
      title={isStale ? STALE_TOOLTIP : "How FMV confidence is computed"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 8px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        letterSpacing: "0.10em",
        color: colors.fg,
        background: colors.bg,
        border: `1px solid ${colors.bd}`,
      }}
    >
      {isStale && <span aria-hidden style={{ fontSize: 9, opacity: 0.85 }}>🕒</span>}
      {key.replace("_", " ")}
    </span>
  )
  if (!href) return pill
  return (
    <Link href={href} style={{ textDecoration: "none" }} aria-label={`${key.replace("_", " ")} confidence — how FMV is computed`}>
      {pill}
    </Link>
  )
}

// ── FMV basis line ────────────────────────────────────────────────────────────
// One honest sentence describing what backs an FMV value, so even a LOW or
// ASK_ONLY tile reads as trustworthy. Pure function (server-safe) consumed by
// FmvBasis below and reusable anywhere the fmv payload is in hand.
//   sales-based + ask : "12 sales (30d) · ask $45"
//   sales-based       : "12 sales (30d)"
//   ASK_ONLY          : "ask-only $45"
//   STALE             : "no sale in 30d · ask $45"  (or "no sale in 30d")
//   NO_DATA / none    : "no market data yet"
export function fmvBasisText({
  confidence,
  salesCount30d,
  ask,
}: {
  confidence: string | null | undefined
  salesCount30d: number | null | undefined
  ask: number | null | undefined
}): string | null {
  const c = (confidence ?? "").toUpperCase()
  const n = typeof salesCount30d === "number" && Number.isFinite(salesCount30d) ? salesCount30d : 0
  const hasAsk = typeof ask === "number" && Number.isFinite(ask) && ask > 0
  const askPart = hasAsk ? `ask ${fmtUsd(ask)}` : null

  if (!confidence || c === "NONE" || c === "NO_DATA") {
    return hasAsk ? `ask-only ${fmtUsd(ask)}` : "no market data yet"
  }
  if (c === "ASK_ONLY") {
    return hasAsk ? `ask-only ${fmtUsd(ask)}` : "ask-only"
  }
  // sales-derived tiers: HIGH / MEDIUM / LOW / SALES_ONLY / STALE
  const salesPart = n > 0 ? `${n} sale${n === 1 ? "" : "s"} (30d)` : null
  if (c === "STALE") {
    if (askPart) return `no sale in 30d · ${askPart}`
    return "no sale in 30d"
  }
  if (salesPart && askPart) return `${salesPart} · ${askPart}`
  if (salesPart) return salesPart
  if (askPart) return askPart
  return null
}

/** Muted basis sub-line for an FMV value. Renders nothing when there's no basis to show. */
export function FmvBasis(props: {
  confidence: string | null | undefined
  salesCount30d: number | null | undefined
  ask: number | null | undefined
}) {
  const text = fmvBasisText(props)
  if (!text) return null
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
      {text}
    </span>
  )
}

// True when the row should render its FMV in muted style (e.g. with a
// dotted underline hint). Centralized so the wallet/collection page,
// edition tiles, and trophy modal stay consistent.
export function isStaleConfidence(confidence: string | null | undefined): boolean {
  return typeof confidence === "string" && confidence.toUpperCase() === "STALE"
}

export const STALE_FMV_TOOLTIP = STALE_TOOLTIP

// ── Stat cell ───────────────────────────────────────────────────────────────

export function StatCell({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rpc-card" style={{ padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>{value}</div>
      {sub !== undefined && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>{sub}</div>
      )}
    </div>
  )
}

// ── Wallet link ─────────────────────────────────────────────────────────────

export function WalletLink({ address }: { address: string | null | undefined }) {
  if (!address) return <span style={{ color: "var(--rpc-text-muted)" }}>{EM_DASH}</span>
  const lower = address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`
  return (
    <Link href={`/profile/${lower}`} style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}>
      {truncWallet(address)}
    </Link>
  )
}

// ── Card section wrapper ────────────────────────────────────────────────────

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rpc-card" style={{ padding: 18, marginTop: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, letterSpacing: "0.10em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// ── Marketplace label ───────────────────────────────────────────────────────

export function marketplaceLabel(raw: string | null | undefined): string {
  if (!raw) return EM_DASH
  const k = raw.toLowerCase()
  if (k === "topshot" || k === "nba_top_shot" || k === "top_shot") return "Top Shot"
  if (k === "allday" || k === "nfl_all_day" || k === "all_day") return "All Day"
  if (k === "golazos" || k === "laliga_golazos") return "Golazos"
  if (k === "ufc" || k === "ufc_strike") return "UFC Strike"
  if (k === "pinnacle" || k === "disney_pinnacle") return "Pinnacle"
  if (k === "flowty") return "Flowty (historical)"
  if (k === "onchain") return "On-chain"
  return raw[0].toUpperCase() + raw.slice(1)
}
