"use client"

// app/insights/parallel-premiums/ParallelPremiumsBoardClient.tsx
//
// Client interactivity for /insights/parallel-premiums. Renders the server's
// initialRows immediately (SEO), then refetches from
// /api/public/insights/parallel-premiums when the user changes the parallel /
// confidence / sort filters. Every row drill-downs to the parallel's own
// edition page (external_id is the canonical setID:playID::subID slug).
//
// premium_mult = parallel FMV / Standard base FMV. Both-sides HIGH/MED is the
// default (the trustworthy set); "All confidence" widens to thin parallels with
// a caveat.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import Link from "next/link"
import type { ParallelRow, ParallelSortKey } from "@/lib/parallel-premiums-board"
import { fetchJson } from "@/lib/analytics/fetch-json"

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 100) return `$${Math.round(v).toLocaleString("en-US")}`
  return `$${v.toFixed(2)}`
}
function fmtMult(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 10) return `${Math.round(v).toLocaleString("en-US")}×`
  return `${v.toFixed(1)}×`
}
function fmtCirc(n: number | null): string {
  return n == null ? "—" : `/${n.toLocaleString("en-US")}`
}
function tierColor(tier: string | null): string {
  switch ((tier ?? "").toUpperCase()) {
    case "LEGENDARY": return "#FFD700"
    case "ULTIMATE": return "#FF6B35"
    case "RARE": return "#818CF8"
    case "FANDOM": return "#34D399"
    default: return "var(--rpc-text-secondary)"
  }
}
function editionHref(r: ParallelRow): string {
  return r.external_id ? `/nba-top-shot/edition/${encodeURIComponent(r.external_id)}` : "#"
}

type SortOpt = { key: ParallelSortKey; label: string }
const SORTS: SortOpt[] = [
  { key: "premium", label: "Premium ↓" },
  { key: "parallel_fmv", label: "Parallel FMV ↓" },
  { key: "scarcity", label: "Scarcity ↓" },
]

export default function ParallelPremiumsBoardClient({
  initialRows,
  initialFailed = false,
  initialFetchedAt,
}: {
  initialRows: ParallelRow[]
  /**
   * ⚠ TRUE when the SERVER read failed, so `initialRows`'s `[]` is an ABSENCE OF
   * DATA rather than an empty result set. Without it this board opened on
   * "No parallels match these filters." — a claim about the FILTERS — and its
   * effect returns early on the first render, so nothing corrects it.
   */
  initialFailed?: boolean
  initialFetchedAt: string
}) {
  const [rows, setRows] = useState<ParallelRow[]>(initialRows)
  const [fetchedAt, setFetchedAt] = useState<string>(initialFetchedAt)
  const [parallel, setParallel] = useState<string | null>(null)
  const [highOnly, setHighOnly] = useState<boolean>(true)
  const [sort, setSort] = useState<ParallelSortKey>("premium")
  const [loading, setLoading] = useState(false)
  // ⚠ A failed refetch used to leave `rows` at the PREVIOUS filter's result,
  // because the write was gated on `Array.isArray(j?.rows)` and an error
  // envelope has no `rows`. The board then showed one filter's data under
  // another filter's label — worse than an empty state, because every row on
  // screen is real and simply answers a question the reader did not ask. Same
  // shape as the analytics player search that showed the previous player's rows.
  // Seeded from the SERVER read; a successful client refetch clears it below.
  const [loadFailed, setLoadFailed] = useState(initialFailed)
  const firstRender = useRef(true)

  // Parallel-name chips derive from the initial (unfiltered-by-name) dataset so
  // they're always accurate to what actually exists.
  const parallelNames = useMemo(() => {
    const s = new Set<string>()
    for (const r of initialRows) if (r.subedition_name) s.add(r.subedition_name)
    return [...s].sort()
  }, [initialRows])

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    const ctrl = new AbortController()
    setLoading(true)
    const qs = new URLSearchParams()
    if (parallel) qs.set("parallel", parallel)
    qs.set("conf", highOnly ? "high" : "all")
    qs.set("sort", sort)
    qs.set("limit", "100")
    setLoadFailed(false)
    // fetchJson gates the parse on the status: this route answers a failure with
    // a well-formed JSON envelope, so a bare `r.json()` resolves and the error
    // object reaches the caller looking like data.
    fetchJson<{ rows?: ParallelRow[]; meta?: { fetched_at?: string } }>(
      `/api/public/insights/parallel-premiums?${qs.toString()}`,
      { signal: ctrl.signal }
    )
      .then((res) => {
        if (ctrl.signal.aborted) return
        if (!res.ok || !Array.isArray(res.json?.rows)) {
          // Clear rather than keep: the stale rows answer the PREVIOUS filter,
          // and leaving them up is the mislabel this guard exists to prevent.
          setLoadFailed(true)
          setRows([])
          return
        }
        setRows(res.json.rows as ParallelRow[])
        if (res.json.meta?.fetched_at) setFetchedAt(res.json.meta.fetched_at)
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [parallel, highOnly, sort])

  const top = rows.slice(0, 3)

  return (
    <main style={{ maxWidth: 1040, margin: "0 auto", padding: "32px 16px 80px" }}>
      <header style={{ marginBottom: 20 }}>
        <div className="rpc-label" style={{ color: "var(--rpc-red)", letterSpacing: "0.12em", fontSize: 11 }}>
          SURFACE · LIVE
        </div>
        <h1 style={{ fontFamily: "var(--font-display)", fontSize: "clamp(28px, 5vw, 44px)", margin: "6px 0 10px", lineHeight: 1.02 }}>
          Parallel Premiums
        </h1>
        <p style={{ color: "var(--rpc-text-secondary)", maxWidth: 720, fontSize: 15, lineHeight: 1.5 }}>
          What each Top Shot parallel — Hexwave, Jukebox, Club Collection, Cosmic — is really worth versus its
          Standard base. The premium is the parallel&apos;s FMV divided by the Standard&apos;s. Top Shot and
          dapper.market name the parallels; only RPC prices them.
        </p>
      </header>

      {/* Filters */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 18 }}>
        <FilterChip active={parallel === null} onClick={() => setParallel(null)} label="All parallels" />
        {parallelNames.map((n) => (
          <FilterChip key={n} active={parallel === n} onClick={() => setParallel(n)} label={n} />
        ))}
        <span style={{ flex: 1 }} />
        <FilterChip active={highOnly} onClick={() => setHighOnly((v) => !v)} label={highOnly ? "High-confidence only" : "All confidence"} />
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as ParallelSortKey)}
          className="rpc-mono"
          style={{ background: "var(--rpc-surface)", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: "6px 10px", fontSize: 12 }}
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Hero tiles */}
      {top.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))", gap: 12, marginBottom: 20 }}>
          {top.map((r) => (
            <Link key={r.edition_id} href={editionHref(r)} style={{ textDecoration: "none" }}>
              <div style={{ border: "1px solid var(--rpc-border)", borderRadius: 12, padding: 16, background: "var(--rpc-surface)", height: "100%" }}>
                <div style={{ fontSize: 11, color: tierColor(r.tier), fontWeight: 700, letterSpacing: "0.05em" }}>
                  {(r.subedition_name ?? "Parallel").toUpperCase()} · {fmtCirc(r.parallel_circ)}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontSize: 22, color: "var(--rpc-text-primary)", margin: "6px 0 2px" }}>
                  {r.player_name ?? "—"}
                </div>
                <div style={{ fontSize: 12, color: "var(--rpc-text-muted)", marginBottom: 12 }}>{r.set_name ?? "—"}</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 26, fontWeight: 800, color: "var(--rpc-red)" }}>
                    {fmtMult(r.premium_mult)}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>vs Standard</span>
                </div>
                <div style={{ fontSize: 12, color: "var(--rpc-text-secondary)", marginTop: 6 }}>
                  {fmtUsd(r.parallel_fmv)} parallel · {fmtUsd(r.base_fmv)} base
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Table */}
      <div style={{ overflowX: "auto", opacity: loading ? 0.6 : 1, transition: "opacity 120ms" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em" }}>
              <th style={th}>Player</th>
              <th style={th}>Parallel</th>
              <th style={{ ...th, textAlign: "right" }}>Mint</th>
              <th style={{ ...th, textAlign: "right" }}>Base FMV</th>
              <th style={{ ...th, textAlign: "right" }}>Parallel FMV</th>
              <th style={{ ...th, textAlign: "right" }}>Premium</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.edition_id} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                <td style={td}>
                  <Link href={editionHref(r)} style={{ color: "var(--rpc-text-primary)", textDecoration: "none", fontWeight: 600 }}>
                    {r.player_name ?? "—"}
                  </Link>
                  <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{r.set_name ?? "—"}</div>
                </td>
                <td style={{ ...td, color: tierColor(r.tier), fontWeight: 700 }}>{r.subedition_name ?? "—"}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtCirc(r.parallel_circ)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-muted)" }}>{fmtUsd(r.base_fmv)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-text-primary)", fontWeight: 700 }}>{fmtUsd(r.parallel_fmv)}</td>
                <td style={{ ...td, textAlign: "right", color: "var(--rpc-red)", fontWeight: 800 }}>{fmtMult(r.premium_mult)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loadFailed ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)" }}>
            Couldn&apos;t load these filters just now &mdash; this says nothing about
            which parallels match.
          </div>
        ) : rows.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40, color: "var(--rpc-text-muted)" }}>
            No parallels match these filters.
          </div>
        ) : null}
      </div>

      <p style={{ marginTop: 18, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5 }}>
        Premium = parallel FMV ÷ Standard-base FMV for the same play. {highOnly ? "Showing only rows where both the parallel and the base carry HIGH/MEDIUM FMV confidence." : "Showing all confidence tiers — thin parallels can overshoot; treat low-confidence rows directionally."}{" "}
        Updated {new Date(fetchedAt).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET.
      </p>
    </main>
  )
}

const th: CSSProperties = { padding: "8px 10px", fontWeight: 600 }
const td: CSSProperties = { padding: "10px" }

function FilterChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="rpc-mono"
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        fontSize: 12,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--rpc-red)" : "var(--rpc-border)"}`,
        background: active ? "var(--rpc-red)" : "transparent",
        color: active ? "#fff" : "var(--rpc-text-secondary)",
      }}
    >
      {label}
    </button>
  )
}
