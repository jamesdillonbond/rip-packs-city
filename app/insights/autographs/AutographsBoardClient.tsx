"use client"

// app/insights/autographs/AutographsBoardClient.tsx
//
// Client interactivity for /insights/autographs. Renders the server's initialRows
// (NBA Top Shot, cheapest live ask first) immediately for crawlers, then refetches
// /api/public/insights/autographs when the reader switches collection or sort.
//
// Market FACTS only — lowest live ask, 90-day sales, last sale, and the unsigned
// printing of the same Moment. No FMV and no confidence (see
// lib/insights/autographs-board.ts). The signed/unsigned multiple is shown only
// where both sides traded at least 3 times in 90 days; the view leaves it NULL
// otherwise, and this renders "—", never a guessed number.

import { useEffect, useRef, useState, type CSSProperties } from "react"
import Link from "next/link"
import {
  autographEditionHref,
  type AutographBoardCollection,
  type AutographBoardSort,
  type AutographRow,
} from "@/lib/insights/autographs-board"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { usdSignFirst } from "@/lib/usd-format"

function fmtUsd(n: number | null): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}
function fmtMult(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  return v >= 10 ? `${Math.round(v).toLocaleString("en-US")}×` : `${v.toFixed(1)}×`
}
function fmtCirc(n: number | null): string {
  return n == null ? "—" : `/${n.toLocaleString("en-US")}`
}
function fmtDay(iso: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric" })
}

const COLLECTIONS: { key: AutographBoardCollection; label: string }[] = [
  { key: "nba_top_shot", label: "NBA Top Shot" },
  { key: "nfl_all_day", label: "NFL All Day" },
]
const SORTS: { key: AutographBoardSort; label: string; blurb: string }[] = [
  { key: "listed", label: "Cheapest listed", blurb: "Signed editions with a live ask, cheapest first." },
  { key: "premium", label: "Biggest premium", blurb: "Signed 90-day median ÷ the unsigned printing's, where both traded 3+ times." },
  { key: "recent", label: "Recently sold", blurb: "Signed editions by their last sale." },
  { key: "scarcity", label: "Scarcest", blurb: "Smallest mint first." },
]

export default function AutographsBoardClient({
  initialRows,
  initialFailed = false,
  initialFetchedAt,
}: {
  initialRows: AutographRow[]
  /** TRUE when the SERVER read failed, so `initialRows`'s `[]` is an absence of data, not "no signed editions". */
  initialFailed?: boolean
  /** `null` when the server read FAILED — the stamp then renders "—", never a clock. */
  initialFetchedAt: string | null
}) {
  const [rows, setRows] = useState<AutographRow[]>(initialRows)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)
  const [collection, setCollection] = useState<AutographBoardCollection>("nba_top_shot")
  const [sort, setSort] = useState<AutographBoardSort>("listed")
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(initialFailed)
  const ctrlRef = useRef<AbortController | null>(null)

  // Loads run from the tab handlers, not from an effect: the server rows already
  // answer the default tab, and each click knows exactly which view it asked for.
  function load(nextCollection: AutographBoardCollection, nextSort: AutographBoardSort) {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    setLoadFailed(false)
    const qs = new URLSearchParams({ collection: nextCollection, sort: nextSort, limit: "200" })
    fetchJson<{ rows?: AutographRow[]; meta?: { fetched_at?: string } }>(
      `/api/public/insights/autographs?${qs.toString()}`,
      { signal: ctrl.signal },
    )
      .then((res) => {
        if (ctrl.signal.aborted) return
        if (!res.ok || !Array.isArray(res.json?.rows)) {
          // Clear rather than keep: stale rows would answer the PREVIOUS tab.
          setLoadFailed(true)
          setRows([])
          return
        }
        setRows(res.json.rows as AutographRow[])
        if (res.json.meta?.fetched_at) setFetchedAt(res.json.meta.fetched_at)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
  }
  useEffect(() => () => ctrlRef.current?.abort(), [])

  function pickCollection(c: AutographBoardCollection) {
    if (c === collection) return
    setCollection(c)
    load(c, sort)
  }
  function pickSort(k: AutographBoardSort) {
    if (k === sort) return
    setSort(k)
    load(collection, k)
  }

  const sortBlurb = SORTS.find((s) => s.key === sort)?.blurb ?? ""

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "32px 16px 80px" }}>
      <header style={{ marginBottom: 20 }}>
        <div className="rpc-label" style={{ color: "var(--rpc-red-text)", letterSpacing: "0.12em", fontSize: 11 }}>
          SURFACE · LIVE
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "clamp(28px, 5vw, 44px)", letterSpacing: "0.5px", textTransform: "uppercase", margin: "6px 0 10px", lineHeight: 1.02 }}>
          Autographed Moments
        </h1>
        <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 760, fontSize: 15, lineHeight: 1.5 }}>
          Every signed NBA Top Shot and NFL All Day edition, read from Dapper&apos;s own autograph data. Signing is per
          edition — often only one parallel of a player&apos;s Moment carries the signature — so this lists the exact
          signed printing, its lowest live ask, what it has traded for, and what the same Moment sells for unsigned.
        </p>
      </header>

      <div role="tablist" aria-label="Collection" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        {COLLECTIONS.map((c) => (
          <Chip key={c.key} active={collection === c.key} onClick={() => pickCollection(c.key)} label={c.label} />
        ))}
      </div>
      <div role="tablist" aria-label="Sort" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        {SORTS.map((s) => (
          <Chip key={s.key} active={sort === s.key} onClick={() => pickSort(s.key)} label={s.label} />
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--rpc-text-muted)", margin: "0 0 16px" }}>{sortBlurb}</p>

      <div style={{ overflowX: "auto", opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <th scope="col" style={th}>Player</th>
              <th scope="col" style={th}>Signed printing</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Mint</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Lowest ask</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>90d sales</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Last sale</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Unsigned 90d</th>
              <th scope="col" style={{ ...th, textAlign: "right" }}>Premium</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.edition_id} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                <td style={td}>
                  <Link href={autographEditionHref(r)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontWeight: 600 }}>
                    {r.player_name ?? "—"}
                  </Link>
                  <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{r.team_name ?? ""}</div>
                </td>
                <td style={td}>
                  <div style={{ color: "var(--rpc-text-secondary)" }}>{r.set_name ?? "—"}</div>
                  {r.parallel && <div style={{ fontSize: 10, color: "var(--rpc-red-text)", fontWeight: 700 }}>{r.parallel}</div>}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtCirc(r.circulation_count)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(r.low_ask)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-secondary)" }}>
                  {r.sales_90d > 0 ? `${r.sales_90d} · ${fmtUsd(r.median_90d)}` : "0"}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-secondary)" }}>
                  {fmtUsd(r.last_sale_usd)}
                  <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{fmtDay(r.last_sale_at)}</div>
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>
                  {r.unsigned_external_id ? (
                    <Link href={autographEditionHref(r, r.unsigned_external_id)} style={{ color: "var(--rpc-text-muted)" }}>
                      {r.unsigned_median_90d != null ? fmtUsd(r.unsigned_median_90d) : "no sales"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-red-text)", fontWeight: 800 }}>{fmtMult(r.premium_x)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loadFailed ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)" }}>
            Couldn&apos;t load this view just now &mdash; this says nothing about which signed editions exist.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)" }}>
            No signed editions match this view.
          </div>
        ) : null}
      </div>

      <p style={{ marginTop: 18, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
        Signed = Dapper&apos;s Atlas marks the edition autographed. Unsigned printing = the same player&apos;s base-set
        edition for a Signature Edition set, or the Standard printing of a signed parallel. Premium = signed 90-day
        median ÷ unsigned 90-day median, shown only when both sides traded at least 3 times.{" "}
        {fetchedAt
          ? `Updated ${new Date(fetchedAt).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} PT.`
          : "Updated — (the read did not complete, so there is no data time to show)."}
      </p>
    </main>
  )
}

const th: CSSProperties = { padding: "8px 10px", fontWeight: 600 }
const td: CSSProperties = { padding: "10px" }

function Chip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="rpc-mono"
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--rpc-red)" : "var(--rpc-border)"}`,
        background: active ? "var(--rpc-red-fill)" : "transparent",
        color: active ? "#fff" : "var(--rpc-text-secondary)",
      }}
    >
      {label}
    </button>
  )
}
