// app/insights/set-completers/SetCompletersBoardClient.tsx
//
// Client interactivity for the Set Completers board. The full board arrives
// server-rendered in `initialBoard` (crawlable HTML); this layer just applies a
// local sort and renders the freshness stamp. RPC tokens only — no hardcoded hex.
"use client"

import { useMemo, useState, type CSSProperties } from "react"
import Link from "next/link"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import { METHOD_NOTE, type SetCompletersBoard } from "@/lib/set-completers-board"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"

type SortKey = "completers" | "rate" | "size"

function fmtInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : "0"
}
function fmtPct(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0%"
  return `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`
}
function thStyle(align: "left" | "right"): CSSProperties {
  return { textAlign: align, padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)" }
}
function tdStyle(align: "left" | "right"): CSSProperties {
  return { textAlign: align, padding: "12px", borderBottom: "1px solid var(--rpc-border-subtle)", verticalAlign: "middle" }
}

export default function SetCompletersBoardClient({
  initialBoard,
  initialFetchedAt,
  initialFailed = false,
}: {
  initialBoard: SetCompletersBoard
  initialFetchedAt: string
  /**
   * Did the SERVER-SIDE read fail? The page's fallback is an empty board, which
   * is indistinguishable from a genuinely empty one. There is NO client refetch
   * here, so a wrong answer is permanent for that viewer.
   */
  initialFailed?: boolean
}) {
  const [sort, setSort] = useState<SortKey>("completers")

  const rows = useMemo(() => {
    const r = [...initialBoard.rows]
    r.sort((a, b) => {
      if (sort === "rate") return b.completion_rate - a.completion_rate || b.completers - a.completers
      if (sort === "size") return b.total_plays - a.total_plays || b.completers - a.completers
      return b.completers - a.completers || b.total_plays - a.total_plays
    })
    return r
  }, [initialBoard.rows, sort])

  const totalCompleters = initialBoard.rows.reduce((s, r) => s + r.completers, 0)

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto", padding: "24px 16px 60px" }}>
      <div className="rpc-mono" style={{ fontSize: 11, letterSpacing: "0.22em", color: "var(--rpc-red)", textTransform: "uppercase" }}>
        Rip Packs City · Insights
      </div>
      <h1 style={{ margin: "10px 0 0", fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 40, letterSpacing: "0.03em", color: "var(--rpc-text-primary)", textTransform: "uppercase", lineHeight: 1.03 }}>
        Set Completers
      </h1>
      <p style={{ margin: "10px 0 0", maxWidth: 720, fontSize: 15, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>
        How many collectors have actually{" "}
        <strong style={{ color: "var(--rpc-text-primary)" }}>completed</strong> each 2025 Top Shot rookie
        set — owning at least one of every base play — from the indexed on-chain ownership graph. A read
        Top Shot&apos;s own site never surfaces.
      </p>

      <div className="rpc-mono" style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 16, fontSize: 11, color: "var(--rpc-text-muted)" }}>
        <span>{fmtInt(totalCompleters)} completions across {initialBoard.rows.length} rookie sets</span>
        <span>· Refreshed <FreshnessStamp iso={initialFetchedAt} /></span>
      </div>

      <div style={{ marginTop: 18, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {([["completers", "Most completers"], ["rate", "Completion rate"], ["size", "Set size"]] as [SortKey, string][]).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setSort(k)}
            className="rpc-mono"
            style={{
              padding: "6px 12px", fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
              borderRadius: 4, border: `1px solid ${sort === k ? "var(--rpc-red)" : "var(--rpc-border)"}`,
              background: sort === k ? "var(--rpc-red-bg)" : "transparent",
              color: sort === k ? "var(--rpc-red)" : "var(--rpc-text-secondary)",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <div className="rpc-card" style={{ marginTop: 18, padding: 24, textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          {/* ⚠ The empty wording is UNCHANGED; only the degraded case is new. */}
          {sectionEmptyCopy(!initialFailed, "Set completers", "No completion data available yet.")}
        </div>
      ) : (
        <div className="rpc-scroll-x" style={{ marginTop: 14, overflowX: "auto" }}>
          <table style={{ width: "100%", minWidth: 620, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={thStyle("left")}>Set</th>
                <th style={thStyle("right")}>Plays</th>
                <th style={thStyle("right")}>Completers</th>
                <th style={thStyle("right")}>Holders</th>
                <th style={thStyle("right")}>Completion rate</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.set_id_onchain}>
                  <td style={tdStyle("left")}>
                    <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--rpc-text-primary)" }}>{r.set_name || `Set ${r.set_id_onchain}`}</span>
                    <span className="rpc-mono" style={{ marginLeft: 8, fontSize: 10, color: "var(--rpc-text-ghost)" }}>#{r.set_id_onchain}</span>
                  </td>
                  <td style={tdStyle("right")}><span className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>{fmtInt(r.total_plays)}</span></td>
                  <td style={tdStyle("right")}><span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 17, color: r.completers > 0 ? "var(--rpc-red)" : "var(--rpc-text-muted)" }}>{fmtInt(r.completers)}</span></td>
                  <td style={tdStyle("right")}><span className="rpc-mono" style={{ color: "var(--rpc-text-secondary)" }}>{fmtInt(r.holders_with_any)}</span></td>
                  <td style={tdStyle("right")}><span className="rpc-mono" style={{ color: "var(--rpc-text-primary)" }}>{fmtPct(r.completion_rate)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="rpc-mono" style={{ marginTop: 20, fontSize: 11, lineHeight: 1.55, color: "var(--rpc-text-muted)" }}>
        {METHOD_NOTE}
      </p>
      <div style={{ marginTop: 16 }}>
        <Link href="/insights" className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-red)", textDecoration: "none" }}>← All insights</Link>
      </div>
    </div>
  )
}
