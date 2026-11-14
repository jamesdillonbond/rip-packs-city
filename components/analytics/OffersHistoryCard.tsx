"use client"

// Wallet offers card for the collection analytics page: the offers this wallet
// has MADE (on-chain Dapper OffersV2). Two views:
//   Open    — feedback #12361 "my open offers": each OPEN offer against the best
//             bid from ANOTHER wallet, the wallet's own higher bid (superseded,
//             never "outbid"), the edition floor, and its age. Default when the
//             wallet has open offers.
//   History — the newest 25 offers with open / filled / cancelled totals (unchanged).
// Read-only — RPC never makes, edits, cancels or accepts an offer.
//
// THREE states, never two (CLAUDE.md "Honesty"), PER VIEW: a failed read says so;
// a read that worked and found nothing says so; rows render. A collection without
// offer tracking (`supported: false`) renders NOTHING rather than a "no offers"
// claim nobody measured. A NULL floor / top bid renders "—" (unknown), never $0.
//
// `id="offers"` is the deep-link target (/dashboard "My offers"). The card mounts
// only after the wallet's analytics load, so the browser's own hash scroll has
// already passed; the card scrolls itself into view once when the hash asks.
import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { fmt, relativeDate } from "@/lib/analytics/format"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { getEntityLabels } from "@/lib/entity-labels"
import { editionHref } from "@/lib/entity-href"
import { fmtBidAge } from "@/lib/market/bid-age"
import { onTablistKeyDown } from "@/lib/a11y/tablist-keys"

type OfferRow = {
  offer_type: string | null
  amount_usd: number | null
  status: string | null
  created_at: string | null
  resolved_at: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
}

type OffersResponse = {
  supported: boolean
  tracked_since?: string
  summary: { total: number; open: number; filled: number; cancelled: number } | null
  rows: OfferRow[]
}

export type OpenOfferRow = {
  offer_id: string
  offer_type: string | null
  amount_usd: number | null
  created_at: string | null
  edition_id: string | null
  edition_external_id: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  parallel: string | null
  serial_number: number | null
  top_other_bid: number | null
  own_higher_usd: number | null
  floor_usd: number | null
  floor_confirmed_at: string | null
  serial_ask_usd: number | null
  serial_ask_seen_at: string | null
  age_days: number | null
  outbid: boolean
  superseded: boolean
  stale: boolean
  at_or_above_floor: boolean
}

export type OpenOffersResponse = {
  supported: boolean
  summary: {
    open: number
    shown: number
    truncated: boolean
    outbid: number
    superseded: number
    stale: number
    at_or_above_floor: number
  } | null
  rows: OpenOfferRow[]
}

type Loaded<T> = { status: "failed" } | { status: "ok"; data: T }

const STATUS_LABEL: Record<string, string> = { open: "Open", filled: "Accepted", cancelled: "Cancelled / expired" }
const STATUS_COLOR: Record<string, string> = {
  open: "var(--rpc-text-primary)",
  filled: "var(--rpc-success)",
  cancelled: "var(--rpc-text-muted)",
}
const TYPE_LABEL: Record<string, string> = { edition: "Edition", subedition: "Parallel", serial: "Serial" }
const PAGE = 50

function trackedSinceLabel(iso: string | undefined): string | null {
  if (!iso) return null
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}

/** Outbid first, then at-or-above-floor, then stale, then newest. */
export function sortOpenOffers(rows: OpenOfferRow[]): OpenOfferRow[] {
  const rank = (r: OpenOfferRow) => (r.outbid ? 0 : r.at_or_above_floor ? 1 : r.stale ? 2 : 3)
  return [...rows].sort((a, b) => {
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    return (Date.parse(b.created_at ?? "") || 0) - (Date.parse(a.created_at ?? "") || 0)
  })
}

function Chip({ label, color, title }: { label: string; color: string; title?: string }) {
  return (
    <span
      title={title}
      className="mr-1 inline-block whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
      style={{ color, borderColor: color }}
    >
      {label}
    </span>
  )
}

function OpenOffersView({ data, urlSlug }: { data: OpenOffersResponse; urlSlug: string }) {
  const [shown, setShown] = useState(PAGE)
  const sorted = useMemo(() => sortOpenOffers(data.rows), [data.rows])
  const s = data.summary

  if (data.rows.length === 0) {
    return (
      <div className="text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
        No open offers for this wallet right now.
      </div>
    )
  }

  return (
    <>
      {s && (
        <div className="mb-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] uppercase tracking-widest" style={{ fontFamily: "var(--font-mono)", color: "var(--rpc-text-muted)" }} data-testid="open-summary">
          <span><b style={{ color: "var(--rpc-text-primary)" }}>{s.open.toLocaleString("en-US")}</b> open</span>
          <span>· <b style={{ color: "var(--rpc-red-text)" }}>{s.outbid.toLocaleString("en-US")}</b> outbid</span>
          {s.superseded > 0 && <span>· <b style={{ color: "var(--rpc-text-secondary)" }}>{s.superseded.toLocaleString("en-US")}</b> superseded by you</span>}
          <span>· <b style={{ color: "var(--rpc-warning-text)" }}>{s.stale.toLocaleString("en-US")}</b> stale</span>
          <span>· <b style={{ color: "var(--rpc-success-text)" }}>{s.at_or_above_floor.toLocaleString("en-US")}</b> at/above floor</span>
        </div>
      )}
      {s?.truncated && (
        <div className="mb-1 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
          Flags cover your newest {s.shown.toLocaleString("en-US")} of {s.open.toLocaleString("en-US")} open offers.
        </div>
      )}
      <div className="mb-3 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
        Read-only: RPC shows your offers, it never makes, edits or cancels them. Manage them on Top Shot.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
          <thead>
            <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
              <th scope="col" className="py-1.5 pr-2">Moment</th>
              <th scope="col" className="py-1.5 pr-2">Type</th>
              <th scope="col" className="py-1.5 pr-2 text-right">Your offer</th>
              <th scope="col" className="py-1.5 pr-2 text-right" title="Highest open offer from another wallet on the same target">Top bid</th>
              <th scope="col" className="py-1.5 pr-2 text-right">Floor</th>
              <th scope="col" className="py-1.5 pr-2 text-right">Age</th>
              <th scope="col" className="py-1.5">Flags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, shown).map((o) => {
              const subject = o.player_name ?? o.set_name ?? "—"
              const detail = [o.set_name && o.player_name ? o.set_name : null, o.parallel, o.serial_number ? `#${o.serial_number}` : null]
                .filter(Boolean)
                .join(" · ")
              const href = o.edition_id ? editionHref(urlSlug, o.edition_external_id, o.edition_id) : null
              const ageDays = o.age_days != null ? Math.floor(o.age_days) : null
              return (
                <tr key={o.offer_id} className="border-b border-[color:var(--rpc-border)] align-top" data-testid="open-offer-row">
                  <td className="py-1.5 pr-2">
                    {href ? (
                      <Link href={href} className="text-[color:var(--rpc-text-primary)] hover:underline">{subject}</Link>
                    ) : (
                      <span className="text-[color:var(--rpc-text-primary)]">{subject}</span>
                    )}
                    {detail && <div className="text-[11px] text-[color:var(--rpc-text-muted)]">{detail}</div>}
                  </td>
                  <td className="py-1.5 pr-2 text-[10px] uppercase text-[color:var(--rpc-text-secondary)]">{(o.offer_type && TYPE_LABEL[o.offer_type]) ?? o.offer_type ?? "—"}</td>
                  <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{o.amount_usd != null ? fmt(o.amount_usd) : "—"}</td>
                  <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]" data-testid="top-bid">{o.top_other_bid != null ? fmt(o.top_other_bid) : "—"}</td>
                  <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]" data-testid="floor">
                    {o.floor_usd != null ? fmt(o.floor_usd) : "—"}
                    {o.floor_usd != null && o.floor_confirmed_at && (
                      <div className="text-[10px] text-[color:var(--rpc-text-muted)]">checked {relativeDate(o.floor_confirmed_at)}</div>
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-muted)]">{ageDays != null ? fmtBidAge(ageDays) : "—"}</td>
                  <td className="py-1.5">
                    {o.outbid && o.top_other_bid != null && (
                      <Chip label="Outbid" color="var(--rpc-red-text)" title={`Another wallet has an open offer of ${fmt(o.top_other_bid)} on this.`} />
                    )}
                    {o.superseded && o.own_higher_usd != null && (
                      <Chip label={`Superseded by your ${fmt(o.own_higher_usd)}`} color="var(--rpc-text-secondary)" title="Your own higher offer is on the same Moment. No other wallet is beating it." />
                    )}
                    {o.stale && <Chip label="Stale 14d+" color="var(--rpc-warning-text)" title="Open 14 days or more without being accepted. Still open." />}
                    {/* "At/above floor" compares against what THIS offer can buy. For a serial offer
                        that is the exact Moment's seen listing, never the edition floor (a different
                        serial) — lib/market/open-offer-flags.ts. */}
                    {o.at_or_above_floor && o.offer_type !== "serial" && o.floor_usd != null && (
                      <Chip label="At/above floor" color="var(--rpc-success-text)" title={`Buying now costs ${fmt(o.floor_usd)}: the floor is at or under your offer.`} />
                    )}
                    {o.serial_ask_usd != null && (
                      <Chip
                        label={o.at_or_above_floor && o.offer_type === "serial" ? `Listed at ${fmt(o.serial_ask_usd)} (≤ your offer)` : `Listed at ${fmt(o.serial_ask_usd)}`}
                        color={o.at_or_above_floor && o.offer_type === "serial" ? "var(--rpc-success-text)" : "var(--rpc-text-secondary)"}
                        title={`This exact Moment was seen listed${o.serial_ask_seen_at ? ` ${relativeDate(o.serial_ask_seen_at)}` : ""}${o.at_or_above_floor && o.offer_type === "serial" ? ", at or under your offer" : ""}. It may have sold since.`}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > shown && (
        <button
          type="button"
          onClick={() => setShown((n) => n + PAGE)}
          className="mt-3 text-[11px] uppercase tracking-widest text-[color:var(--rpc-red-text)] hover:underline"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Show more ({(sorted.length - shown).toLocaleString("en-US")} left)
        </button>
      )}
    </>
  )
}

function HistoryView({ data, urlSlug }: { data: OffersResponse; urlSlug: string }) {
  const since = trackedSinceLabel(data.tracked_since)
  if (data.rows.length === 0) {
    return (
      <div className="text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
        No offers recorded for this wallet{since ? ` since ${since}` : ""}.
      </div>
    )
  }
  return (
    <>
      {data.summary && (
        <div className="mb-3 flex flex-wrap gap-4 text-[11px] uppercase tracking-widest" style={{ fontFamily: "var(--font-mono)" }}>
          <span style={{ color: "var(--rpc-text-muted)" }}>Total <b style={{ color: "var(--rpc-text-primary)" }}>{data.summary.total.toLocaleString("en-US")}</b></span>
          <span style={{ color: "var(--rpc-text-muted)" }}>Open <b style={{ color: STATUS_COLOR.open }}>{data.summary.open.toLocaleString("en-US")}</b></span>
          <span style={{ color: "var(--rpc-text-muted)" }}>Accepted <b style={{ color: STATUS_COLOR.filled }}>{data.summary.filled.toLocaleString("en-US")}</b></span>
          <span style={{ color: "var(--rpc-text-muted)" }}>Cancelled / expired <b style={{ color: "var(--rpc-text-secondary)" }}>{data.summary.cancelled.toLocaleString("en-US")}</b></span>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
          <thead>
            <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
              <th scope="col" className="py-1.5 pr-2">Type</th>
              <th scope="col" className="py-1.5 pr-2">{getEntityLabels(urlSlug).player}</th>
              <th scope="col" className="py-1.5 pr-2">Set</th>
              <th scope="col" className="py-1.5 pr-2">Serial</th>
              <th scope="col" className="py-1.5 pr-2 text-right">Offer</th>
              <th scope="col" className="py-1.5 pr-2">Status</th>
              <th scope="col" className="py-1.5 text-right">Made</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((o, i) => (
              <tr key={i} className="border-b border-[color:var(--rpc-border)]">
                <td className="py-1.5 pr-2 text-[10px] uppercase text-[color:var(--rpc-text-secondary)]">{(o.offer_type && TYPE_LABEL[o.offer_type]) ?? o.offer_type ?? "—"}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">{o.player_name ?? "—"}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{o.set_name ?? "—"}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{o.serial_number ? `#${o.serial_number}` : "—"}</td>
                <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{o.amount_usd != null ? fmt(o.amount_usd) : "—"}</td>
                <td className="py-1.5 pr-2 text-[10px] uppercase" style={{ color: (o.status && STATUS_COLOR[o.status]) || "var(--rpc-text-muted)" }}>
                  {(o.status && STATUS_LABEL[o.status]) ?? o.status ?? "—"}
                </td>
                <td className="py-1.5 text-right text-[color:var(--rpc-text-muted)]">{o.created_at ? relativeDate(o.created_at) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

export default function OffersHistoryCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  // Results are stored WITH the request they answer, so a wallet/collection
  // change reads as loading (key mismatch) without a setState inside the effect.
  const key = `${wallet}|${urlSlug}`
  const [history, setHistory] = useState<{ key: string; r: Loaded<OffersResponse> } | null>(null)
  const [open, setOpen] = useState<{ key: string; r: Loaded<OpenOffersResponse> } | null>(null)
  const [picked, setPicked] = useState<{ key: string; tab: "open" | "history" } | null>(null)
  const sectionRef = useRef<HTMLElement | null>(null)
  const scrolled = useRef(false)

  useEffect(() => {
    let cancelled = false
    const k = `${wallet}|${urlSlug}`
    const base = `/api/wallet-offers?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}`
    fetchJson<OffersResponse>(`${base}&limit=25`).then((r) => {
      if (cancelled) return
      setHistory({ key: k, r: !r.ok || !r.json ? { status: "failed" } : { status: "ok", data: r.json } })
    })
    fetchJson<OpenOffersResponse>(`${base}&view=open`).then((r) => {
      if (cancelled) return
      setOpen({ key: k, r: !r.ok || !r.json ? { status: "failed" } : { status: "ok", data: r.json } })
    })
    return () => { cancelled = true }
  }, [wallet, urlSlug])

  const ready = history?.key === key && open?.key === key

  useEffect(() => {
    if (!ready || scrolled.current) return
    if (typeof window !== "undefined" && window.location.hash === "#offers" && sectionRef.current) {
      scrolled.current = true
      sectionRef.current.scrollIntoView?.({ behavior: "smooth", block: "start" })
    }
  }, [ready])

  if (!ready || !history || !open) return null
  const h = history.r
  const o = open.r
  // No offer tracking for this collection: render nothing (never a "no offers" claim).
  if ((h.status === "ok" && !h.data.supported) || (o.status === "ok" && !o.data.supported)) return null

  const defaultTab: "open" | "history" = o.status === "ok" && (o.data.summary?.open ?? 0) > 0 ? "open" : "history"
  const tab = picked?.key === key ? picked.tab : defaultTab
  const since = h.status === "ok" ? trackedSinceLabel(h.data.tracked_since) : null

  const tabBtn = (t: "open" | "history", label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === t}
      onClick={() => setPicked({ key, tab: t })}
      className="mr-3 border-b-2 pb-0.5 text-[11px] uppercase tracking-widest"
      style={{
        fontFamily: "var(--font-mono)",
        color: tab === t ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
        borderColor: tab === t ? "var(--rpc-red)" : "transparent",
      }}
    >
      {label}
    </button>
  )

  return (
    <section
      id="offers"
      ref={sectionRef}
      className="scroll-mt-24 rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4"
    >
      <h2 className="mb-1 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
        Offers Made
      </h2>
      <div className="mb-3 text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
        On-chain offers this wallet has placed{since ? `, tracked since ${since}` : ""}.
      </div>
      <div className="mb-3" role="tablist" aria-label="Offers view" onKeyDown={onTablistKeyDown} tabIndex={-1}>
        {tabBtn("open", o.status === "ok" && o.data.summary ? `Open (${o.data.summary.open.toLocaleString("en-US")})` : "Open")}
        {tabBtn("history", "History")}
      </div>

      {tab === "open" ? (
        o.status === "failed" ? (
          <div className="text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
            Couldn&apos;t load open offers right now. This is a loading error, not an empty list. Try again shortly.
          </div>
        ) : (
          <OpenOffersView data={o.data} urlSlug={urlSlug} />
        )
      ) : h.status === "failed" ? (
        <div className="text-sm" style={{ color: "var(--rpc-text-secondary)" }}>
          Couldn&apos;t load offers right now. This is a loading error, not an empty history. Try again shortly.
        </div>
      ) : (
        <HistoryView data={h.data} urlSlug={urlSlug} />
      )}
    </section>
  )
}
