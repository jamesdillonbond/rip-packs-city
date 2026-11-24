"use client"

// components/entity/TeamSeriesChecklists.tsx
// Team Series Checklists (Trevor, 2026-11-23): Top Shot's "collect a Moment of every
// <team> player from a series" — one row per series with players owned / total, a
// progress bar, "N to go · $X" and a Closest badge; a row expands to the roster.
//
// Mounted inside TeamChecklist (team entity only), which owns the wallet: this component
// never asks for one. Pinnacle returns no series, so it renders nothing there.
//
// The money figure is the sum of the cheapest LIVE ask (<= 3x FMV, FMV required) per
// missing player. A missing player with no such ask is counted as "unlisted" and left
// OUT of the sum, and the sum is then shown as "≥ $X" — never a $0 player, never the
// historical floor (a-historical-minimum-sale-is-not-a-cost-to-buy).
// Brand tokens only (var(--rpc-*), var(--font-display)).

import { useEffect, useState } from "react"
import Link from "next/link"
import { fmtUsd } from "./_shared"
import { tileSeriesLabel } from "@/lib/series-label"
import { editionRouteHref } from "@/lib/entity-href"
import { proxyIpfsImageUrl } from "@/lib/ipfs-media"
import {
  closestSeries,
  parseTeamSeriesChecklists,
  toGoParts,
  type SeriesChecklist,
  type TeamSeriesChecklists as Data,
} from "@/lib/entity/team-series-checklists"

interface Props {
  collectionUrlSlug: string
  teamSlug: string
  teamLabel?: string
  wallet: string | null
  /** Opens the edition grid below on this series. */
  onOpenSeries?: (seriesNum: number) => void
}

const GREEN = "#34D399"

function money(n: number): string {
  // fmtUsd prints an em dash for 0; a real cost here is never 0 when shown.
  return n >= 100
    ? n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : fmtUsd(n)
}

export default function TeamSeriesChecklists({ collectionUrlSlug, teamSlug, teamLabel, wallet, onOpenSeries }: Props) {
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    const p = new URLSearchParams({ collection: collectionUrlSlug, slug: teamSlug })
    if (wallet) p.set("wallet", wallet)
    fetch(`/api/entity/team-series-checklists?${p.toString()}`, { cache: "no-store" })
      .then(async r => {
        if (!r.ok) throw new Error(String(r.status))
        const j = await r.json()
        if (!cancelled) { setData(parseTeamSeriesChecklists(j)); setFailed(false) }
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [collectionUrlSlug, teamSlug, wallet])

  if (failed) {
    return (
      <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-muted)", padding: "8px 0 14px" }}>
        Couldn&apos;t load the series checklists right now — a temporary load failure, not an empty team.
      </div>
    )
  }
  if (!data || data.series.length === 0) return null

  const hasWallet = !!wallet
  const closest = closestSeries(data.series, hasWallet)
  const who = teamLabel ?? "this team"

  return (
    <section aria-label="Series checklists" style={{ marginBottom: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <h3 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, margin: 0, color: "var(--rpc-text-primary)" }}>
          Series Checklists
        </h3>
      </div>
      <p style={{ fontSize: 12, color: "var(--rpc-text-muted)", margin: "0 0 10px" }}>
        Collect a Moment of every player on {who} from a series to complete its checklist.
        {" "}Cost is the cheapest live ask for each player still to go{hasWallet ? "" : " (track a wallet below to see yours)"}.
      </p>
      {hasWallet && data.wallet_cached === false && (
        <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 8 }}>
          No cards indexed for this wallet yet — owned counts read 0 until its holdings load.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {data.series.map(s => (
          <SeriesRow
            key={s.series_num}
            s={s}
            collectionUrlSlug={collectionUrlSlug}
            hasWallet={hasWallet}
            isClosest={closest === s.series_num}
            expanded={open === s.series_num}
            onToggle={() => setOpen(prev => (prev === s.series_num ? null : s.series_num))}
            onOpenSeries={onOpenSeries}
          />
        ))}
      </div>
    </section>
  )
}

function SeriesRow({ s, collectionUrlSlug, hasWallet, isClosest, expanded, onToggle, onOpenSeries }: {
  s: SeriesChecklist
  collectionUrlSlug: string
  hasWallet: boolean
  isClosest: boolean
  expanded: boolean
  onToggle: () => void
  onOpenSeries?: (n: number) => void
}) {
  const label = tileSeriesLabel(String(s.series_num), collectionUrlSlug) ?? `Series ${s.series_num}`
  const owned = s.players_owned ?? 0
  const pct = hasWallet && s.players_total > 0 ? Math.round((owned / s.players_total) * 100) : 0
  const complete = hasWallet && s.complete === true
  const panelId = `series-cl-${s.series_num}`

  return (
    <div className="rpc-card" style={{ padding: 0, overflow: "hidden" }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={panelId}
        style={{
          all: "unset", boxSizing: "border-box", cursor: "pointer", width: "100%",
          display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "center", columnGap: 12, rowGap: 8, padding: "12px 14px",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>Series</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)", lineHeight: 1.15 }}>
            {label.replace(/^Series\s+/i, "")}
          </div>
        </div>
        <div className="rpc-mono" style={{ fontSize: 11, textAlign: "right", color: complete ? GREEN : "var(--rpc-text-primary)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
          <span>{complete ? "\u2713 Complete" : toGoParts(s, money).join(" \u00b7 ")}</span>
          <span aria-hidden style={{ color: "var(--rpc-text-muted)", transform: expanded ? "rotate(180deg)" : undefined, transition: "transform 150ms ease" }}>{"\u25be"}</span>
        </div>
        <div style={{ gridColumn: "1 / -1", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
              {hasWallet ? `${owned}/${s.players_total} players` : `${s.players_total} players`}
            </span>
            {isClosest && (
              <span className="rpc-mono" style={{ fontSize: 10, padding: "2px 8px", borderRadius: 999, background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", color: "var(--rpc-red-text)" }}>
                Closest
              </span>
            )}
          </div>
          <div role="progressbar" aria-valuemin={0} aria-valuemax={s.players_total} aria-valuenow={hasWallet ? owned : 0} aria-label={`${label} players owned`}
            style={{ height: 6, borderRadius: 999, background: "var(--rpc-surface-raised)", overflow: "hidden" }}>
            <div style={{ width: `${pct}%`, height: "100%", background: GREEN, transition: "width 200ms ease" }} />
          </div>
        </div>
      </button>

      {expanded && (
        <div id={panelId} style={{ borderTop: "1px solid var(--rpc-border)", padding: "10px 14px 12px" }}>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 6 }}>
            {s.players.map(p => {
              const has = p.owned === true
              const href = p.cheapest_route_slug ? editionRouteHref(collectionUrlSlug, p.cheapest_route_slug) : null
              const thumb = p.thumbnail_url ? proxyIpfsImageUrl(p.thumbnail_url) : null
              const body = (
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 6, borderRadius: 6, background: "var(--rpc-surface)", border: `1px solid ${has ? "rgba(52,211,153,0.45)" : "var(--rpc-border)"}` }}>
                  {thumb
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={thumb} alt="" width={36} height={36} loading="lazy" style={{ borderRadius: 4, objectFit: "cover", flex: "0 0 auto", opacity: has || !hasWallet ? 1 : 0.7 }} />
                    : <div style={{ width: 36, height: 36, borderRadius: 4, background: "var(--rpc-surface-raised)", flex: "0 0 auto" }} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--rpc-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.player_name}</div>
                    <div className="rpc-mono" style={{ fontSize: 10, color: has ? GREEN : "var(--rpc-text-muted)" }}>
                      {has
                        ? `✓ Owned${p.owned_count > 1 ? ` ×${p.owned_count}` : ""}`
                        : p.cheapest_ask_usd != null
                          ? `From ${money(p.cheapest_ask_usd)} ASK`
                          : "Unlisted — no fair ask"}
                    </div>
                  </div>
                </div>
              )
              return (
                <li key={p.player_key}>
                  {href
                    ? <Link href={href} title={p.cheapest_name ? `Cheapest: ${p.cheapest_name}` : undefined} style={{ textDecoration: "none", color: "inherit" }}>{body}</Link>
                    : body}
                </li>
              )
            })}
          </ul>
          {onOpenSeries && (
            <button type="button" className="rpc-chip" onClick={() => onOpenSeries(s.series_num)} style={{ marginTop: 10, cursor: "pointer" }}>
              Show every {label} edition below
            </button>
          )}
        </div>
      )}
    </div>
  )
}
