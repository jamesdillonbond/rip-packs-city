"use client"

// app/insights/pinnacle-scarcity/page.tsx
//
// Surface H — Disney Pinnacle Scarcity Board. Pinnacle's equivalent of the
// Top Shot squeeze board, scoped to the different supply mechanic Pinnacle
// uses (mint count + variant family + chaser status, no lock/burn).
//
// Data: GET /api/public/insights/pinnacle-scarcity → reads the
// pinnacle_scarcity_board view shipped 2026-05-30 via
// audit_20260530_pinnacle_scarcity_board_view_for_surface_h.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

type Row = {
  edition_id: string
  character_name: string | null
  franchise: string | null
  set_name: string | null
  variant_type: string | null
  mint_count: number | null
  is_chaser: boolean | null
  ask_price: number | null
  variant_avg_mint: number | null
  scarcity_vs_variant_pct: number | null
  fmv_usd: number | null
  fmv_confidence: string | null
  thumbnail_url: string | null
}

type ApiResponse = {
  meta: { fetched_at: string; total_rows: number }
  rows: Row[]
}

type SortKey = "scarcity" | "mint" | "fmv"
type FranchiseFilter = "ALL" | "Pixar" | "Star Wars" | "Marvel" | "Walt Disney"

function fmtInt(n: number | null | undefined): string {
  if (n == null) return "—"
  return Number(n).toLocaleString("en-US")
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}
function fmtPct(n: number | null | undefined): string {
  if (n == null) return "—"
  return `${Number(n).toFixed(1)}%`
}

export default function PinnacleScarcityPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(null)

  const [sort, setSort] = useState<SortKey>("scarcity")
  const [franchise, setFranchise] = useState<FranchiseFilter>("ALL")
  const [chasersOnly, setChasersOnly] = useState(false)

  useEffect(() => {
    const ctrl = new AbortController()
    async function run() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ sort, limit: "100" })
        if (franchise !== "ALL") params.set("franchise", franchise)
        if (chasersOnly) params.set("chasers_only", "true")
        const r = await fetch(`/api/public/insights/pinnacle-scarcity?${params.toString()}`, {
          signal: ctrl.signal,
          cache: "no-store",
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const j = (await r.json()) as ApiResponse
        setRows(j.rows ?? [])
        setFetchedAt(j.meta?.fetched_at ?? null)
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === "AbortError") return
        setError(e instanceof Error ? e.message : "Failed to load")
      } finally {
        setLoading(false)
      }
    }
    run()
    return () => ctrl.abort()
  }, [sort, franchise, chasersOnly])

  const tweetIntent = useMemo(() => {
    const text = `Pinnacle doesn't show you the supply story. We do.\n\nEditions ranked by how rare they actually are vs their variant family:`
    const url = `${SITE_URL}/insights/pinnacle-scarcity`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`
  }, [])

  return (
    <main style={styles.page}>
      <style>{CSS}</style>

      <section className="rpc-ps-hero">
        <div className="rpc-ps-eyebrow">RPC Insights · Public</div>
        <h1 className="rpc-ps-h1">Pinnacle Scarcity Board</h1>
        <p className="rpc-ps-lede">
          Disney Pinnacle doesn&apos;t have Top Shot&apos;s lock + burn
          mechanic. Its scarcity comes from <strong>low mint counts</strong>{" "}
          within a variant family, <strong>chaser status</strong>, and
          premium variants. This board ranks editions by how far below their
          variant family&apos;s average mint they sit.
        </p>
        <div className="rpc-ps-meta-row">
          <span className="rpc-ps-meta">
            Updated{" "}
            {fetchedAt
              ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
              : "—"}
          </span>
          <span className="rpc-ps-meta-sep">·</span>
          <span className="rpc-ps-meta">Refreshes hourly</span>
          <span className="rpc-ps-meta-sep">·</span>
          <span className="rpc-ps-meta">No signup</span>
        </div>
      </section>

      <section className="rpc-ps-callout" aria-label="Chasers status">
        <div className="rpc-ps-callout-line">
          <strong>Chasers note:</strong> Pinnacle has 8 platform-wide chaser
          editions. They aren&apos;t in this ranking yet — they came in via
          wallet scans before Pinnacle&apos;s catalog resolver populated
          their mint counts, so they fall outside the view&apos;s
          {" "}<code>mint_count IS NOT NULL</code> filter. Same eight names you
          already know from Pinnacle: Xenomorph, Belle, Cinderella, Monterey
          Jack &amp; Zipper, Boba Fett, G.N.K, Sally, Bubbles. They&apos;ll
          appear here once their catalog metadata lands.
        </div>
      </section>

      <section className="rpc-ps-controls" aria-label="Filters">
        <div className="rpc-ps-pill-group">
          <span className="rpc-ps-pill-label">FRANCHISE</span>
          {(["ALL", "Pixar", "Star Wars", "Marvel", "Walt Disney"] as FranchiseFilter[]).map((f) => (
            <button
              key={f}
              className={`rpc-ps-pill ${franchise === f ? "rpc-ps-pill-active" : ""}`}
              onClick={() => setFranchise(f)}
            >
              {f}
            </button>
          ))}
        </div>

        <label className="rpc-ps-check">
          <input
            type="checkbox"
            checked={chasersOnly}
            onChange={(e) => setChasersOnly(e.target.checked)}
          />
          <span>Chasers only</span>
        </label>

        <label className="rpc-ps-sort">
          <span className="rpc-ps-pill-label">SORT</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rpc-ps-select"
          >
            <option value="scarcity">Scarcity vs variant (desc)</option>
            <option value="mint">Mint count (asc)</option>
            <option value="fmv">FMV (desc)</option>
          </select>
        </label>
      </section>

      <section className="rpc-ps-table-wrap">
        {error ? (
          <div className="rpc-ps-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ps-state">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="rpc-ps-state">No editions match those filters.</div>
        ) : (
          <table className="rpc-ps-table">
            <thead>
              <tr>
                <th>Character / Set</th>
                <th className="rpc-ps-th-num">Variant</th>
                <th className="rpc-ps-th-num">Mint</th>
                <th className="rpc-ps-th-num">Var avg</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">Scarcity</th>
                <th className="rpc-ps-th-num">FMV</th>
                <th className="rpc-ps-th-num">Ask</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.edition_id}>
                  <td className="rpc-ps-td-edition">
                    <div className="rpc-ps-edition-name">
                      {r.character_name ?? "—"}
                      {r.is_chaser ? <span className="rpc-ps-chaser-chip">CHASER</span> : null}
                    </div>
                    <div className="rpc-ps-edition-set">{r.set_name ?? "—"}</div>
                  </td>
                  <td className="rpc-ps-td-num">{r.variant_type ?? "—"}</td>
                  <td className="rpc-ps-td-num">{fmtInt(r.mint_count)}</td>
                  <td className="rpc-ps-td-num">
                    {r.variant_avg_mint ? fmtInt(Math.round(Number(r.variant_avg_mint))) : "—"}
                  </td>
                  <td className="rpc-ps-td-num rpc-ps-td-emph">{fmtPct(r.scarcity_vs_variant_pct)}</td>
                  <td className="rpc-ps-td-num">{fmtUsd(r.fmv_usd)}</td>
                  <td className="rpc-ps-td-num">{fmtUsd(r.ask_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rpc-ps-footer">
        <div className="rpc-ps-method">
          <h3 className="rpc-ps-h3">Methodology</h3>
          <p>
            <strong>Scarcity vs variant</strong> = how much rarer this edition
            is than the average edition in its variant family. Positive % =
            rarer. A Lumière Standard at 333 mint sits 70% below the Standard
            variant&apos;s 1,133 average. A Digital Display at the same mint
            sits closer to its average because Digital Display itself is rare.
          </p>
          <p>
            <strong>Chaser</strong> = a Pinnacle-designated rare variant
            (8 across the platform). <strong>FMV</strong> = latest snapshot
            from the <code>pinnacle-1.0.0</code> algo, hourly. Editions with
            <code>set_name = &lsquo;Unknown&rsquo;</code> (stub rows from
            wallet scans) are excluded.
          </p>
        </div>
        <div className="rpc-ps-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-ps-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-ps-back">
            More public insights →
          </Link>
        </div>
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--rpc-black)",
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-body)",
    padding: "32px 20px 80px",
  },
}

const CSS = `
.rpc-ps-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-ps-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-ps-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-ps-h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-ps-lede { font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-ps-lede strong { color: var(--rpc-text-primary); }
.rpc-ps-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ps-callout { max-width: 1180px; margin: 0 auto 18px; }
.rpc-ps-callout-line {
  padding: 12px 14px;
  background: var(--rpc-red-bg);
  border-left: 3px solid var(--rpc-red);
  border-radius: 2px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--rpc-text-secondary);
}
.rpc-ps-callout-line strong { color: var(--rpc-text-primary); margin-right: 4px; }
.rpc-ps-callout-line code {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--rpc-text-primary);
  background: rgba(255,255,255,0.06);
  padding: 1px 4px;
  border-radius: 2px;
}

.rpc-ps-controls { max-width: 1180px; margin: 0 auto 18px; display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; }
.rpc-ps-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ps-pill-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); margin-right: 4px; }
.rpc-ps-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; }
.rpc-ps-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ps-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ps-check { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; color: var(--rpc-text-secondary); cursor: pointer; }
.rpc-ps-check input { accent-color: var(--rpc-red); }
.rpc-ps-sort { display: inline-flex; align-items: center; gap: 8px; }
.rpc-ps-select { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; background: transparent; border: 1px solid var(--rpc-border); color: var(--rpc-text-primary); padding: 7px 10px; border-radius: 2px; cursor: pointer; }

.rpc-ps-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-ps-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-ps-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-ps-th-num { text-align: right; }
.rpc-ps-th-emph { color: var(--rpc-red); }
.rpc-ps-table td { padding: 12px; border-bottom: 1px solid var(--rpc-border-subtle); vertical-align: middle; }
.rpc-ps-td-edition { min-width: 280px; }
.rpc-ps-edition-name { font-weight: 700; font-size: 15px; color: var(--rpc-text-primary); display: flex; align-items: center; gap: 8px; }
.rpc-ps-edition-set { font-family: var(--font-mono); font-size: 11px; color: var(--rpc-text-muted); letter-spacing: 1px; margin-top: 2px; }
.rpc-ps-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-ps-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-ps-chaser-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1.5px; padding: 2px 6px; background: var(--rpc-red-bg); color: var(--rpc-red); border: 1px solid var(--rpc-red-border); border-radius: 2px; }

.rpc-ps-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-ps-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-ps-method strong { color: var(--rpc-text-primary); }
.rpc-ps-method code { font-family: var(--font-mono); font-size: 12px; color: var(--rpc-text-primary); }
.rpc-ps-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ps-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; }
.rpc-ps-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ps-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-ps-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) { .rpc-ps-footer { grid-template-columns: 1fr; } }
`
