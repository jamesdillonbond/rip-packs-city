// components/entity/_shared.tsx
// Phase 1A/1B/1C/1D/1E/1F.
// Server-safe formatting and tiny presentational helpers used across every
// entity detail page (edition, set, player, team, series). Keep this file
// free of "use client" directives — anything client-only lives in its own
// component.

import Link from "next/link"
import type { ReactNode } from "react"
import { fmvBasis } from "@/lib/fmv-basis"

export const EM_DASH = "—"

// ── Team-moment subject ──────────────────────────────────────────────────────
// Tile/row subject line shared by every entity surface. Player moments → the
// player; team moments (player_name null — WNBA Skyline, Season Rewind, Squad
// Goals, ...) → "<team> <play>" (e.g. "Chicago Bulls Reel"), mirroring
// app/moment/[id]'s momentSubject and dapper.market. Lives here (server-safe,
// no "use client") so both server components (TeamActivity/TeamSqueeze/
// PopularOnCollection) and client components (the grids) can call it. Loose
// structural param so any row shape with these fields works.
export function tileSubject(e: {
  player_name?: string | null
  team_name?: string | null
  play_type?: string | null
  name?: string | null
}): string {
  if (e.player_name && e.player_name.trim()) return e.player_name
  if (e.team_name && e.team_name.trim()) {
    const play = e.play_type && e.play_type.trim() && e.play_type !== "Unknown" ? ` ${e.play_type}` : ""
    return `${e.team_name}${play}`
  }
  if (e.name && e.name.trim()) return e.name
  return "Edition"
}

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

const GRAY_FALLBACK = { fg: "var(--rpc-text-secondary)", bg: "var(--rpc-surface-raised)", bd: "var(--rpc-border)" }

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

// ── Confidence pill — REMOVED 2026-07-11 ───────────────────────────────────
// ConfidencePill / CONFIDENCE_COLORS / STALE_TOOLTIP deleted (Trevor: no
// confidence or stale/ask labeling anywhere on the UI; tiers are build-time
// signal only). Do not reintroduce a tier/stale chip on any public surface.

/** Canonical methodology explainer. */
export const FMV_METHODOLOGY_HREF = "/legal/fmv-methodology"

// ── FMV basis line ────────────────────────────────────────────────────────────
// Factual sub-line describing what backs an FMV value: sales count and/or the
// live ask. 2026-07-11 (Trevor): no confidence/stale/ask-only labeling anywhere
// on the UI — just the raw facts, nothing when there are none.
//
// AMENDED 2026-08-01 (Trevor: "disclose basis, platform-wide"). The no-tier rule
// still binds — HIGH/MEDIUM/LOW/STALE never reach the DOM. But one distinction is
// a FACT, not a tier: ~5,800 editions carry an FMV that is 0.90 × a single
// seller's ask because nothing has ever traded, and nothing distinguished them
// from a sale-derived price. `FmvBasis` now appends a plain-English "from asks"
// marker for exactly that case, via lib/fmv-basis.ts. `fmvBasisText` is
// deliberately UNCHANGED (it stays a pure string helper, still ignoring
// confidence) so its contract and callers are untouched.
//   sales-based + ask : "12 sales (30d) · ask $45"
//   sales-based       : "12 sales (30d)"
//   ask only          : "ask $45"
//   nothing           : null (renders nothing)
export function fmvBasisText({
  confidence: _confidence,
  salesCount30d,
  ask,
}: {
  confidence: string | null | undefined
  salesCount30d: number | null | undefined
  ask: number | null | undefined
}): string | null {
  const n = typeof salesCount30d === "number" && Number.isFinite(salesCount30d) ? salesCount30d : 0
  const hasAsk = typeof ask === "number" && Number.isFinite(ask) && ask > 0
  const askPart = hasAsk ? `ask ${fmtUsd(ask)}` : null
  const salesPart = n > 0 ? `${n} sale${n === 1 ? "" : "s"} (30d)` : null

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
  // Ask-derived disclosure: this FMV is a discount on one seller's asking price,
  // not a market price. Plain words only — never the confidence enum.
  const basis = fmvBasis(props.confidence)
  if (!text && !basis) return null
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
      {text}
      {basis ? (
        <span
          title={basis.title}
          style={{ marginLeft: text ? 6 : 0, color: "var(--rpc-warning, #e0a64b)", cursor: "help" }}
        >
          {basis.label}
        </span>
      ) : null}
    </span>
  )
}

// (isStaleConfidence / STALE_FMV_TOOLTIP removed 2026-07-11 — no consumers,
// and no stale labeling on the UI.)

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

export function WalletLink({ address, name }: { address: string | null | undefined; name?: string | null }) {
  if (!address) return <span style={{ color: "var(--rpc-text-muted)" }}>{EM_DASH}</span>
  const lower = address.toLowerCase().startsWith("0x") ? address.toLowerCase() : `0x${address.toLowerCase()}`
  return (
    <Link
      href={`/profile/${lower}`}
      title={name ? `${name} · ${lower}` : lower}
      style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontFamily: "var(--font-mono)", fontSize: 11 }}
    >
      {name ? `@${name}` : truncWallet(address)}
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

// ── Section-level failure ───────────────────────────────────────────────────

/**
 * Rendered INSIDE a section whose read failed, in place of that section's
 * content. Reports OUR failure and claims nothing about the data.
 *
 * ⚠ This is the difference between "we could not look" and "there are none",
 * on a surface where the second is a factual claim the reader will act on.
 * The alternative it replaces is not an empty grid — it is the page's
 * whole-page `*Unavailable`, which discards a hero and a stat strip that were
 * already read and already true (R19).
 *
 * `noun` is a noun PHRASE and completes "Couldn't load ___" — "the editions in
 * this series", "this team's roster". Keep it specific: the reader is looking
 * at a page that otherwise rendered, so a generic "data" reads as a bug rather
 * than as one section that did not come back.
 */
export function SectionUnavailable({ noun }: { noun: string }) {
  return (
    <div
      style={{
        border: "1px solid var(--rpc-red-border)",
        padding: "18px 16px",
        textAlign: "center",
      }}
    >
      <div
        className="rpc-mono"
        style={{ fontSize: 11, letterSpacing: "0.24em", textTransform: "uppercase", color: "var(--rpc-red)" }}
      >
        Couldn&rsquo;t load {noun}
      </div>
      <p style={{ margin: "10px auto 0", maxWidth: 460, fontSize: 13, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>
        The data didn&rsquo;t come back in time. This is a problem on our side &mdash; it does{" "}
        <strong>not</strong> mean there are none. Reloading often works.
      </p>
    </div>
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
