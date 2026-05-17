"use client"

// app/(collections)/[collection]/pack/[id]/PackLifecycleClient.tsx
//
// Client subcomponents for the pack lifecycle page. All styling pulls from
// rpc-tokens.css via var(--rpc-*) — no hardcoded hex values, no hardcoded
// font names. The signature design moment is <RipPerforation/> — an SVG
// horizontal perforation that visually separates the "before rip" half
// (ownership chain) from the "after rip" half (pulls grid).

import { useEffect, useState } from "react"
import type { ReactNode } from "react"
import Link from "next/link"
import type {
  Distribution,
  OwnershipEvent,
  PackPull,
  PackStatus,
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

/** Whole-dollar amounts drop the trailing ".00" so headlines read "$20" rather
 *  than "$20.00". Sub-dollar amounts keep two decimals. */
function fmtUsd(n: number | string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  if (v === Math.trunc(v)) {
    return `$${v.toLocaleString("en-US")}`
  }
  return v.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtPrice(n: number | string | null | undefined, currency: string | null | undefined): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  const formatted = v.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return currency ? `${formatted} ${currency}` : formatted
}

/** DUC is 1:1 USD-pegged, so we render DUC amounts as plain USD and drop the
 *  "DUC" suffix entirely — every observed Top Shot pack pays in DUC and the
 *  parenthetical doubles up on the same number. Non-DUC currencies (FLOW,
 *  USDC, etc.) keep their suffix so the unit isn't lost. */
function fmtPriceWithUsd(
  n: number | string | null | undefined,
  currency: string | null | undefined,
): string {
  if (n === null || n === undefined || n === "") return "—"
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return "—"
  if (currency && currency.toUpperCase() === "DUC") {
    return fmtUsd(v)
  }
  return fmtPrice(v, currency)
}

/** "Dec 2022" style month-year for the distribution metadata strip. */
function formatMonthYear(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" })
}

/** Rewrite a Top Shot CDN /editions/ thumbnail URL through the resize endpoint
 *  so the browser fetches an already-optimized webp at the requested width.
 *  The raw Hero_2880_2880_Transparent.png is ~2880px square (multi-MB) —
 *  rendering it directly into a ~220px card is why pull thumbnails look fuzzy.
 *  Non-Top-Shot CDN URLs pass through unchanged. */
function resizedThumb(url: string | null | undefined, width: number = 900): string | null {
  if (!url) return null
  if (url.includes("assets.nbatopshot.com/editions/")) {
    const resized = url.replace(
      "assets.nbatopshot.com/editions/",
      "assets.nbatopshot.com/resize/editions/",
    )
    return `${resized}?format=webp&quality=80&width=${width}`
  }
  return url
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
                  {(ev.custom_id ?? "purchase").replace(/_/g, " ").toLowerCase()}
                </span>
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--rpc-text-muted)",
                  }}
                  title={ev.sealed_at}
                >
                  {relativeTime(ev.sealed_at)}
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
                  {fmtPriceWithUsd(ev.sale_price, ev.sale_currency)}
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
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : pull.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resizedThumb(pull.thumbnail_url, 900) ?? pull.thumbnail_url}
            alt={pull.player_name ?? `Moment #${pull.nft_id}`}
            loading="lazy"
            decoding="async"
            sizes="(max-width: 768px) 50vw, 220px"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
            }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
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
              padding: "1px 5px",
              background: `var(--tier-${tierKey}-bg)`,
              border: `1px solid var(--tier-${tierKey}-border)`,
              color: `var(--tier-${tierKey})`,
              fontFamily: "var(--font-display)",
              fontSize: 9,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              borderRadius: "var(--radius-sm)",
              opacity: 0.85,
              pointerEvents: "none",
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
  totalCostBasis,
  basisCurrency,
  grossPullValueUsd,
  roiPct,
}: {
  totalCostBasis: number | null
  basisCurrency: string | null
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
      <StatCell label="Cost basis" value={fmtPriceWithUsd(totalCostBasis, basisCurrency)} />
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
  subhead,
  delta,
  deltaDirection,
}: {
  headline: string
  /** Subhead can be a plain string ("NOT YET BOUGHT") or mixed-font JSX such
   *  as `<>PAID <span className="rpc-hero-sub-amt">$10</span></>`. */
  subhead?: ReactNode | null
  delta: string | null
  deltaDirection: "up" | "down" | "flat" | null
}) {
  const color =
    deltaDirection === "up"
      ? "var(--rpc-success)"
      : deltaDirection === "down"
        ? "var(--rpc-danger)"
        : "var(--rpc-text-muted)"
  // Headline color tracks the delta direction so PULLED $X visually reads as
  // win/loss at a glance; if there's no delta context (sealed pack or null
  // basis), fall back to primary text so the headline stays legible.
  const headlineColor = deltaDirection ? color : "var(--rpc-text-primary)"
  return (
    <div className="rpc-hero-delta">
      <div className="rpc-hero-pulled" style={{ color: headlineColor }}>
        {headline}
      </div>
      {subhead && <div className="rpc-hero-sub">{subhead}</div>}
      {delta && (
        <div className="rpc-hero-delta-line" style={{ color }}>
          {delta}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// StatusBadge — sealed / ripped / unknown pill
// ─────────────────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: PackStatus }) {
  if (status === "ripped") {
    return (
      <span
        style={{
          fontFamily: "var(--font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          fontSize: 12,
          padding: "4px 10px",
          background: "var(--rpc-red)",
          color: "#fff",
          borderRadius: "var(--radius-sm)",
        }}
      >
        Ripped
      </span>
    )
  }
  if (status === "sealed") {
    return (
      <span
        style={{
          fontFamily: "var(--font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          fontSize: 12,
          padding: "4px 10px",
          background: "transparent",
          color: "var(--rpc-text-primary)",
          border: "1px solid var(--rpc-text-primary)",
          borderRadius: "var(--radius-sm)",
        }}
      >
        Sealed
      </span>
    )
  }
  return (
    <span
      style={{
        fontFamily: "var(--font-display)",
        textTransform: "uppercase",
        letterSpacing: "0.14em",
        fontSize: 12,
        padding: "4px 10px",
        background: "transparent",
        color: "var(--rpc-text-muted)",
        border: "1px dashed var(--rpc-border)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      Unknown
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// PackIdentityHero — pack image + title + tier + metadata + on-chain id
// ─────────────────────────────────────────────────────────────────────────
//
// Two rendering modes:
//   - drop_pool         → full identity: image, tier, drop date, retail, slots
//   - purchase_metadata → reward-pack mode: title + "Reward pack" tag, no image
//
// When `distribution` is null the parent (page.tsx) skips this hero entirely
// and renders a minimal title-only block — see PackIdentityMinimal.
//
// StatusBadge sits next to the title so the user sees "what is this pack" and
// "what state is it in" together at the top of the page.

function PackImagePlaceholder({ label }: { label: string }) {
  return (
    <div
      aria-hidden
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        color: "var(--rpc-text-ghost)",
        background:
          "repeating-linear-gradient(135deg, var(--rpc-surface) 0 10px, var(--rpc-surface-raised) 10px 20px)",
      }}
    >
      <span style={{ fontFamily: "var(--font-display)", fontSize: 36, lineHeight: 1 }}>?</span>
      <span
        style={{
          fontFamily: "var(--font-display)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          padding: "0 4px",
          textAlign: "center",
        }}
      >
        {label}
      </span>
    </div>
  )
}

/** Renders the pack image and falls back to the placeholder card if the CDN
 *  URL 404s or otherwise fails to load. Keeps the parent container the same
 *  size in both states so layout doesn't shift. */
function PackHeroImage({
  src,
  alt,
  fallbackLabel,
}: {
  src: string
  alt: string
  fallbackLabel: string
}) {
  const [errored, setErrored] = useState(false)
  if (errored) return <PackImagePlaceholder label={fallbackLabel} />
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="eager"
      decoding="async"
      sizes="(max-width: 640px) 96px, 200px"
      onError={() => setErrored(true)}
    />
  )
}

export function PackIdentityHero({
  distribution,
  packNftId,
  packName,
  status,
  firstSeenAt,
}: {
  distribution: Distribution
  packNftId: string
  packName: string | null
  status: PackStatus
  firstSeenAt: string | null
}) {
  const isFullDist = distribution.source === "drop_pool"
  const isRewardPack = distribution.source === "purchase_metadata"
  const title = distribution.title ?? packName ?? `Pack #${packNftId}`
  const tier = distribution.tier ?? null
  const tierKey = tierTokenKey(tier)
  const imgUrl = isFullDist ? distribution.image_url ?? null : null
  const dropDateFmt = formatMonthYear(distribution.drop_date)
  const retailFmt =
    distribution.retail_price_usd !== null && distribution.retail_price_usd !== undefined
      ? `${fmtUsd(distribution.retail_price_usd)} retail`
      : null
  const slotsFmt =
    distribution.pack_slots !== null && distribution.pack_slots !== undefined
      ? `${distribution.pack_slots} moments per pack`
      : null

  return (
    <div className="rpc-pack-id">
      <div className="rpc-pack-id-image">
        {imgUrl ? (
          <PackHeroImage
            src={imgUrl}
            alt={title}
            fallbackLabel={isRewardPack ? "Reward pack" : "Image unavailable"}
          />
        ) : (
          <PackImagePlaceholder label={isRewardPack ? "Reward pack" : "Image unavailable"} />
        )}
      </div>

      <div className="rpc-pack-id-text">
        <div className="rpc-pack-id-title-row">
          <h1 className="rpc-pack-id-title">{title}</h1>
          <StatusBadge status={status} />
        </div>

        {(tier || isRewardPack) && (
          <div className="rpc-pack-id-tagrow">
            {tier && (
              <span
                style={{
                  display: "inline-block",
                  padding: "3px 10px",
                  background: `var(--tier-${tierKey}-bg)`,
                  border: `1px solid var(--tier-${tierKey}-border)`,
                  color: `var(--tier-${tierKey})`,
                  fontFamily: "var(--font-display)",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                {tier}
              </span>
            )}
            {isRewardPack && (
              <span
                style={{
                  display: "inline-block",
                  padding: "3px 10px",
                  background: "transparent",
                  border: "1px dashed var(--rpc-border)",
                  color: "var(--rpc-text-muted)",
                  fontFamily: "var(--font-display)",
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.1em",
                  borderRadius: "var(--radius-sm)",
                }}
              >
                Reward pack
              </span>
            )}
          </div>
        )}

        {(dropDateFmt || retailFmt || slotsFmt) && (
          <div className="rpc-pack-id-meta-row">
            {dropDateFmt && <span className="rpc-pack-id-meta-pill">{dropDateFmt}</span>}
            {retailFmt && <span className="rpc-pack-id-meta-pill">{retailFmt}</span>}
            {slotsFmt && <span className="rpc-pack-id-meta-pill">{slotsFmt}</span>}
          </div>
        )}

        <PackOnChainIdRow packNftId={packNftId} firstSeenAt={firstSeenAt} />
      </div>
    </div>
  )
}

/** Minimal identity used when `distribution` is null — no image, no tier,
 *  just the title + status badge + on-chain id. Honest about the fact that
 *  we don't know what this pack is. */
export function PackIdentityMinimal({
  packName,
  packNftId,
  status,
  firstSeenAt,
}: {
  packName: string | null
  packNftId: string
  status: PackStatus
  firstSeenAt: string | null
}) {
  const title = packName ?? `Pack #${packNftId}`
  return (
    <div className="rpc-pack-id-min">
      <div className="rpc-pack-id-title-row">
        <h1 className="rpc-pack-id-title">{title}</h1>
        <StatusBadge status={status} />
      </div>
      <PackOnChainIdRow packNftId={packNftId} firstSeenAt={firstSeenAt} />
    </div>
  )
}

function PackOnChainIdRow({
  packNftId,
  firstSeenAt,
}: {
  packNftId: string
  firstSeenAt: string | null
}) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 0,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--rpc-text-muted)",
      }}
    >
      <span>#{packNftId}</span>
      <CopyButton value={packNftId} label="pack id" />
      {firstSeenAt && (
        <>
          <span aria-hidden style={{ color: "var(--rpc-text-ghost)", margin: "0 8px" }}>·</span>
          <span title={firstSeenAt}>first seen {relativeTime(firstSeenAt)}</span>
        </>
      )}
    </div>
  )
}
