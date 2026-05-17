"use client"

// app/(collections)/[collection]/pack/[id]/PackLifecycleClient.tsx
//
// Client subcomponents for the pack lifecycle page. All styling pulls from
// rpc-tokens.css via var(--rpc-*) — no hardcoded hex values, no hardcoded
// font names. The signature design moment is <RipPerforation/> — an SVG
// horizontal perforation that visually separates the "before rip" half
// (ownership chain) from the "after rip" half (pulls grid).

import { useEffect, useState } from "react"
import Link from "next/link"
import type {
  OwnershipEvent,
  PackPull,
  RipEvent,
} from "./types"

// ─────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────

function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "—"
  const a = addr.trim()
  if (a.length <= 10) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return "—"
  const h = hash.trim()
  if (h.length <= 12) return h
  return `${h.slice(0, 8)}…${h.slice(-6)}`
}

function flowscanTxUrl(hash: string): string {
  return `https://www.flowscan.io/tx/${encodeURIComponent(hash)}`
}

function flowscanAccountUrl(addr: string): string {
  return `https://www.flowscan.io/account/${encodeURIComponent(addr)}`
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ""
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diffSec = Math.max(0, (Date.now() - t) / 1000)
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 30 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`
  if (diffSec < 365 * 86_400) return `${Math.floor(diffSec / (30 * 86_400))}mo ago`
  return `${Math.floor(diffSec / (365 * 86_400))}y ago`
}

function fmtUsd(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
}

function fmtPrice(n: number | string | null | undefined, currency: string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  const formatted = v.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return currency ? `${formatted} ${currency}` : formatted
}

const TIER_ALIASES: Record<string, string> = {
  COMMON: "common",
  FANDOM: "fandom",
  RARE: "rare",
  LEGENDARY: "legendary",
  ULTIMATE: "ultimate",
  UNCOMMON: "uncommon",
  CHALLENGER: "challenger",
  CONTENDER: "contender",
  CHAMPION: "champion",
}

function tierTokenKey(tier: string | null): string {
  if (!tier) return "common"
  return TIER_ALIASES[tier.toUpperCase()] ?? "common"
}

// ─────────────────────────────────────────────────────────────────────────
// CopyButton — click-to-copy with a 1.6s "copied!" affordance
// ─────────────────────────────────────────────────────────────────────────

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch {
      /* silently ignore — clipboard may be blocked */
    }
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied!" : `Copy ${label ?? value}`}
      style={{
        marginLeft: 6,
        padding: "0 6px",
        height: 18,
        background: "transparent",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-sm)",
        color: copied ? "var(--rpc-success)" : "var(--rpc-text-muted)",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        lineHeight: 1,
        cursor: "pointer",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      {copied ? "✓" : "copy"}
    </button>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// AddressChip — short address + copy + flowscan link
// ─────────────────────────────────────────────────────────────────────────

export function AddressChip({ addr, label }: { addr: string | null; label?: string }) {
  if (!addr) return <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>—</span>
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 0 }}>
      <a
        href={flowscanAccountUrl(addr)}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: "var(--rpc-text-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          textDecoration: "none",
          borderBottom: "1px dotted var(--rpc-border)",
        }}
      >
        {shortAddr(addr)}
      </a>
      <CopyButton value={addr} label={label ?? "address"} />
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// TxChip — tx hash + flowscan link
// ─────────────────────────────────────────────────────────────────────────

export function TxChip({ hash }: { hash: string }) {
  return (
    <a
      href={flowscanTxUrl(hash)}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      style={{
        color: "var(--rpc-text-secondary)",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        textDecoration: "none",
        borderBottom: "1px dotted var(--rpc-border-subtle)",
      }}
    >
      {shortHash(hash)}
    </a>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// OwnershipTimeline — vertical dot-line-dot chain of purchase events
// ─────────────────────────────────────────────────────────────────────────

export function OwnershipTimeline({ events }: { events: OwnershipEvent[] }) {
  if (events.length === 0) {
    return (
      <div
        style={{
          padding: "var(--space-lg)",
          border: "1px dashed var(--rpc-border)",
          borderRadius: "var(--radius-md)",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-display)",
          fontSize: 14,
          textAlign: "center",
        }}
      >
        Acquired off-chain
      </div>
    )
  }

  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, position: "relative" }}>
      {events.map((ev, idx) => {
        const isLast = idx === events.length - 1
        return (
          <li
            key={`${ev.tx_hash}-${idx}`}
            style={{
              position: "relative",
              paddingLeft: 28,
              paddingBottom: isLast ? 0 : "var(--space-lg)",
            }}
          >
            {/* dot */}
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 4,
                top: 4,
                width: 10,
                height: 10,
                borderRadius: "var(--radius-full)",
                background: "var(--rpc-red)",
                boxShadow: "0 0 0 3px var(--rpc-red-bg)",
              }}
            />
            {/* line */}
            {!isLast && (
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  left: 9,
                  top: 16,
                  bottom: 0,
                  width: 0,
                  borderLeft: "1px dashed var(--rpc-border)",
                }}
              />
            )}
            <div
              style={{
                background: "var(--rpc-surface-raised)",
                border: "1px solid var(--rpc-border)",
                borderRadius: "var(--radius-md)",
                padding: "var(--space-md)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: "var(--space-sm)",
                  marginBottom: 8,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-display)",
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    fontSize: 11,
                    color: "var(--rpc-text-secondary)",
                  }}
                >
                  {(ev.event_type ?? "purchase").replace(/_/g, " ")}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--rpc-text-muted)",
                  }}
                  title={ev.timestamp}
                >
                  {relativeTime(ev.timestamp)}
                </span>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "auto 1fr",
                  rowGap: 4,
                  columnGap: "var(--space-md)",
                  fontSize: 12,
                }}
              >
                <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Buyer</span>
                <AddressChip addr={ev.buyer_address} label="buyer" />
                <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Seller</span>
                <AddressChip addr={ev.seller_address} label="seller" />
                <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Price</span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-primary)" }}>
                  {fmtPrice(ev.price, ev.currency)}
                </span>
                <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Tx</span>
                <TxChip hash={ev.tx_hash} />
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// RipPerforation — the signature horizontal "pack tear" divider
// ─────────────────────────────────────────────────────────────────────────

export function RipPerforation({ rip }: { rip: RipEvent }) {
  return (
    <section aria-label="Pack rip event" style={{ margin: "var(--space-2xl) 0" }}>
      {/* perforation SVG — a row of triangular tears with a dashed mid-line */}
      <div
        aria-hidden
        style={{
          position: "relative",
          height: 24,
          width: "100%",
          color: "var(--rpc-red)",
          marginBottom: "var(--space-lg)",
        }}
      >
        <svg
          width="100%"
          height="24"
          viewBox="0 0 1200 24"
          preserveAspectRatio="none"
          style={{ display: "block" }}
        >
          {/* dashed midline */}
          <line
            x1="0"
            y1="12"
            x2="1200"
            y2="12"
            stroke="currentColor"
            strokeWidth="1"
            strokeDasharray="6 6"
            opacity="0.5"
          />
          {/* zig-zag tear edge */}
          <path
            d="M0,12 L20,4 L40,12 L60,4 L80,12 L100,4 L120,12 L140,4 L160,12 L180,4 L200,12 L220,4 L240,12 L260,4 L280,12 L300,4 L320,12 L340,4 L360,12 L380,4 L400,12 L420,4 L440,12 L460,4 L480,12 L500,4 L520,12 L540,4 L560,12 L580,4 L600,12 L620,4 L640,12 L660,4 L680,12 L700,4 L720,12 L740,4 L760,12 L780,4 L800,12 L820,4 L840,12 L860,4 L880,12 L900,4 L920,12 L940,4 L960,12 L980,4 L1000,12 L1020,4 L1040,12 L1060,4 L1080,12 L1100,4 L1120,12 L1140,4 L1160,12 L1180,4 L1200,12"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="none"
          />
        </svg>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr",
          columnGap: "var(--space-md)",
          rowGap: 6,
          maxWidth: 760,
          margin: "0 auto",
          padding: "var(--space-md) var(--space-lg)",
          background: "var(--rpc-red-bg)",
          border: "1px solid var(--rpc-red-border)",
          borderRadius: "var(--radius-md)",
          fontSize: 12,
        }}
      >
        <span
          style={{
            gridColumn: "1 / -1",
            fontFamily: "var(--font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.12em",
            fontSize: 14,
            color: "var(--rpc-red)",
            marginBottom: 4,
          }}
        >
          Ripped — {rip.moments_pulled} moments pulled
        </span>
        <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Opener</span>
        <AddressChip addr={rip.opener_address} label="opener" />
        <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Sealed at</span>
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-primary)" }} title={rip.sealed_at}>
          {relativeTime(rip.sealed_at)}
        </span>
        <span style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-display)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 10 }}>Tx</span>
        <TxChip hash={rip.tx_hash} />
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PullCard — a single moment card in the pulls grid
// ─────────────────────────────────────────────────────────────────────────

function PullCard({ pull, collection }: { pull: PackPull; collection: string }) {
  const [hovering, setHovering] = useState(false)
  const unhydrated = pull.edition_id === null

  if (unhydrated) {
    return (
      <div
        style={{
          background: "var(--rpc-surface-raised)",
          border: "1px dashed var(--rpc-border)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-md)",
          aspectRatio: "3 / 4",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            flex: 1,
            background: "var(--rpc-surface)",
            borderRadius: "var(--radius-sm)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--rpc-text-ghost)",
            fontFamily: "var(--font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            fontSize: 11,
            marginBottom: 8,
          }}
        >
          Hydrating…
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)" }}>
          #{pull.nft_id}
        </div>
      </div>
    )
  }

  const tierKey = tierTokenKey(pull.tier)
  const hasVideo = Boolean(pull.video_url)

  return (
    <Link
      href={`/${collection}/moment/${encodeURIComponent(pull.nft_id)}`}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      style={{
        textDecoration: "none",
        color: "inherit",
        display: "block",
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-md)",
        overflow: "hidden",
        transition: "border-color var(--transition-fast), transform var(--transition-fast)",
      }}
    >
      <div
        style={{
          aspectRatio: "1 / 1",
          background: "var(--rpc-surface)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {hasVideo && hovering ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            src={pull.video_url ?? undefined}
            autoPlay
            muted
            loop
            playsInline
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : pull.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={pull.thumbnail_url}
            alt={pull.player_name ?? `Moment #${pull.nft_id}`}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--rpc-text-ghost)",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
            }}
          >
            No image
          </div>
        )}
        {hasVideo && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              bottom: 6,
              right: 6,
              width: 22,
              height: 22,
              borderRadius: "var(--radius-full)",
              background: "rgba(0,0,0,0.55)",
              color: "var(--rpc-text-primary)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
            }}
          >
            ▶
          </div>
        )}
        {pull.tier && (
          <span
            style={{
              position: "absolute",
              top: 6,
              left: 6,
              padding: "2px 6px",
              background: `var(--tier-${tierKey}-bg)`,
              border: `1px solid var(--tier-${tierKey}-border)`,
              color: `var(--tier-${tierKey})`,
              fontFamily: "var(--font-display)",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {pull.tier}
          </span>
        )}
      </div>
      <div style={{ padding: "var(--space-md)" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 16,
            color: "var(--rpc-text-primary)",
            textTransform: "uppercase",
            letterSpacing: "0.02em",
            marginBottom: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {pull.player_name ?? "—"}
        </div>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 12,
            color: "var(--rpc-text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            marginBottom: 10,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {pull.set_name ?? "—"}
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--rpc-text-secondary)",
            marginBottom: 4,
          }}
        >
          <span>
            {pull.serial_number ?? "—"}
            <span style={{ color: "var(--rpc-text-muted)" }}>
              /{pull.circulation_count ?? "—"}
            </span>
          </span>
          <span style={{ color: "var(--rpc-text-muted)" }}>FMV</span>
        </div>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
          }}
        >
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--rpc-text-muted)",
            }}
          >
            {shortAddr(pull.current_owner)}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              color: "var(--rpc-text-primary)",
            }}
          >
            {fmtUsd(pull.current_fmv)}
          </span>
        </div>
      </div>
    </Link>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PullsGrid — responsive grid wrapper
// ─────────────────────────────────────────────────────────────────────────

export function PullsGrid({ pulls, collection }: { pulls: PackPull[]; collection: string }) {
  if (pulls.length === 0) {
    return (
      <div
        style={{
          padding: "var(--space-xl)",
          textAlign: "center",
          color: "var(--rpc-text-muted)",
          fontFamily: "var(--font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          border: "1px dashed var(--rpc-border)",
          borderRadius: "var(--radius-md)",
        }}
      >
        No pulls indexed yet
      </div>
    )
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
        gap: "var(--space-md)",
      }}
    >
      {pulls.map(p => (
        <PullCard key={p.nft_id} pull={p} collection={collection} />
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// StatsFooter — 3-column summary
// ─────────────────────────────────────────────────────────────────────────

export function StatsFooter({
  totalCostBasisUsd,
  grossPullValueUsd,
  roiPct,
}: {
  totalCostBasisUsd: number | null
  grossPullValueUsd: number | null
  roiPct: number | null
}) {
  const roiColor =
    roiPct === null
      ? "var(--rpc-text-muted)"
      : roiPct >= 0
        ? "var(--rpc-success)"
        : "var(--rpc-danger)"
  const roiLabel = roiPct === null ? "—" : `${roiPct >= 0 ? "+" : ""}${roiPct.toFixed(1)}%`

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
        gap: "var(--space-md)",
        marginTop: "var(--space-2xl)",
        padding: "var(--space-lg)",
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <StatCell label="Cost basis" value={fmtUsd(totalCostBasisUsd)} />
      <StatCell label="Gross pull value" value={fmtUsd(grossPullValueUsd)} />
      <StatCell label="ROI" value={roiLabel} color={roiColor} large />
    </div>
  )
}

function StatCell({
  label,
  value,
  color,
  large,
}: {
  label: string
  value: string
  color?: string
  large?: boolean
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 11,
          color: "var(--rpc-text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: large ? 32 : 24,
          color: color ?? "var(--rpc-text-primary)",
          lineHeight: 1,
        }}
      >
        {value}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// HeroDelta — the "Pack ripped for $X (+$Y)" headline number
// ─────────────────────────────────────────────────────────────────────────

export function HeroDelta({
  headline,
  delta,
  deltaDirection,
}: {
  headline: string
  delta: string | null
  deltaDirection: "up" | "down" | "flat" | null
}) {
  const color =
    deltaDirection === "up"
      ? "var(--rpc-success)"
      : deltaDirection === "down"
        ? "var(--rpc-danger)"
        : "var(--rpc-text-muted)"
  return (
    <div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 32,
          color: "var(--rpc-text-primary)",
          lineHeight: 1.1,
        }}
      >
        {headline}
      </div>
      {delta && (
        <div
          style={{
            marginTop: 4,
            fontFamily: "var(--font-mono)",
            fontSize: 16,
            color,
          }}
        >
          {delta}
        </div>
      )}
    </div>
  )
}
