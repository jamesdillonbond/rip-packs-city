"use client"

// PaniniSniper — the Panini Sniper tab body (/panini-blockchain/sniper, 2026-09-28).
// Server-seeded from the hourly `panini-boards` snapshot (lib/insights/panini-more-boards.ts)
// — the same deal rows the /insights/panini-squeeze Deals tab shows, so the tab costs no
// extra DB read. The shared Sniper client is a Flow feed (wallet ownership, badges,
// watchlist, per-listing buy flows) and none of it applies to Panini.
//
// Honesty rules this component keeps:
//   · the listing-gated coverage disclosure sits above the table: Panini publishes no
//     checklist, so this is every deal on what RPC has SEEN listed, not a census
//   · three states — "couldn't load", genuinely none, rows — and a filter that hides
//     every row says the FILTER did it, never "no deals"
//   · sale-backed deals lead and are labelled; FMV-only deals say they have no recent
//     sale to check against
//   · the ask is as of its last confirmation (PT date shown), and the board's own
//     computed-at time is shown — a snapshot, not a live feed
//   · a capped board says it is capped
//   · RPC is read-only: the only action is a link to the card's Panini marketplace page

import { useMemo, useState } from "react"
import Link from "next/link"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import type { DegradedSummary } from "@/lib/insights/board-status"
import { paniniEditionUrl } from "@/lib/panini/edition-market"

type Num = number | null

export interface PaniniSniperDeal {
  sku: string
  player_name: string | null
  parallel: string | null
  tier: string | null
  serial_number: Num
  mint_cap: Num
  ask_usd: Num
  last_sale_usd: Num
  fmv_usd: Num
  discount_pct: Num
  est_profit_usd: Num
  special_flag: string | null
  ask_confirmed_at: string | null
  recent_sales_median_usd: Num
  recent_sales_n: Num
  deal_basis: string | null
}

export interface PaniniSniperData {
  deals: PaniniSniperDeal[] | null
  dealsError: boolean
  dealsCapped: boolean
  coverage: { total_editions?: Num; pct_trustworthy?: Num } | null
  computedAt: string | null
}

const mono = "var(--font-mono)"
const display = "var(--font-display)"
const BACKED = "fmv_and_recent_sales"
const MIN_DISCOUNTS = [15, 25, 40] as const

function usd(n: Num | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: n >= 100 ? 0 : 2 })
}
function int(n: Num | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}
/** Absolute PT date/time — the reader's clock never enters render. */
function ptWhen(iso: string | null, withTime: boolean): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }
    : { month: "short", day: "numeric", timeZone: "America/Los_Angeles" }
  return new Date(t).toLocaleString("en-US", opts) + (withTime ? " PT" : "")
}
/** The edition key of a serial sku ("<psku>__<serial>_<cap>"), or null when it has no such suffix. */
export function paniniEditionKeyOfSku(sku: string): string | null {
  const m = /^(.+)__\d+_\d+$/.exec(sku)
  return m ? m[1] : null
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}

const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
const chip = (on: boolean): React.CSSProperties => ({
  fontFamily: mono, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 12px", borderRadius: 6, cursor: "pointer",
  background: on ? "var(--rpc-red-bg)" : "transparent",
  border: `1px solid ${on ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
  color: on ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
})

export default function PaniniSniper({ data, degraded }: { data: PaniniSniperData | null; degraded: DegradedSummary | null }) {
  const [backedOnly, setBackedOnly] = useState(false)
  const [specialOnly, setSpecialOnly] = useState(false)
  const [minDiscount, setMinDiscount] = useState<number>(MIN_DISCOUNTS[0])
  const [query, setQuery] = useState("")

  const all = data?.deals ?? null
  const counts = useMemo(() => {
    if (!all) return null
    const backed = all.filter((r) => r.deal_basis === BACKED).length
    return { total: all.length, backed, fmvOnly: all.length - backed }
  }, [all])

  const shown = useMemo(() => {
    if (!all) return null
    const q = query.trim().toLowerCase()
    const rows = all.filter(
      (r) =>
        (!backedOnly || r.deal_basis === BACKED) &&
        (!specialOnly || !!r.special_flag) &&
        (r.discount_pct ?? 0) >= minDiscount &&
        (!q || (r.player_name ?? "").toLowerCase().includes(q) || (r.parallel ?? "").toLowerCase().includes(q)),
    )
    // Sale-backed first, then by estimated edge — the board's own order, restated so a
    // filter can never reorder it.
    return rows.sort(
      (a, b) =>
        Number(b.deal_basis === BACKED) - Number(a.deal_basis === BACKED) ||
        (b.est_profit_usd ?? -Infinity) - (a.est_profit_usd ?? -Infinity) ||
        a.sku.localeCompare(b.sku),
    )
  }, [all, backedOnly, specialOnly, minDiscount, query])

  const cov = data?.coverage ?? null
  const filtering = backedOnly || specialOnly || minDiscount !== MIN_DISCOUNTS[0] || query.trim() !== ""

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "16px 16px 40px" }}>
      <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 6px" }}>
        Panini — Sniper
      </h1>
      <Note>
        Listed Panini Prizm World Cup serials asking at least 15% under FMV (with #1 / jersey-number / perfect-mint premiums applied), each ask re-read
        in the last 7 days, on editions with an FMV of $25 or more. Cards whose edition FMV rests on asks alone are left out.
      </Note>
      <div role="note" style={{ padding: "10px 14px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 6, margin: "12px 0" }}>
        <Note>
          <b>A floor, not a census.</b> Panini publishes no checklist, so RPC only knows a card once it has been listed.
          {cov && cov.pct_trustworthy != null
            ? ` Of the ${int(cov.total_editions ?? null)} editions indexed, ${cov.pct_trustworthy}% sit in sets with broad listing coverage.`
            : ""}{" "}
          This board refreshes about hourly{data?.computedAt ? ` — computed ${ptWhen(data.computedAt, true)}` : ""}; a card may have sold since its ask was
          last seen.
        </Note>
      </div>
      <DegradedDataNotice summary={degraded} />

      {!data || data.dealsError || !all || !counts || !shown ? (
        <div role="alert" style={{ padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
          <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load Panini deals</div>
          <Note>The deal board is unavailable right now. This is not the same as there being no deals.</Note>
        </div>
      ) : counts.total === 0 ? (
        <div data-testid="panini-sniper-none" style={{ padding: "14px 16px", border: "1px dashed var(--rpc-border)", borderRadius: 8 }}>
          <Note>No listed card RPC has seen is priced at least 15% under its FMV right now.</Note>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "8px 0 10px" }}>
            <button type="button" aria-pressed={backedOnly} onClick={() => setBackedOnly((v) => !v)} style={chip(backedOnly)}>
              Sale-backed only
            </button>
            <button type="button" aria-pressed={specialOnly} onClick={() => setSpecialOnly((v) => !v)} style={chip(specialOnly)}>
              Special serials
            </button>
            {MIN_DISCOUNTS.map((d) => (
              <button key={d} type="button" aria-pressed={minDiscount === d} onClick={() => setMinDiscount(d)} style={chip(minDiscount === d)}>
                ≥{d}% under
              </button>
            ))}
            <label htmlFor="panini-sniper-q" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              Filter by player or parallel
            </label>
            <input
              id="panini-sniper-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Player or parallel"
              autoComplete="off"
              spellCheck={false}
              maxLength={60}
              style={{ flex: "1 1 180px", minWidth: 0, padding: "6px 10px", fontFamily: mono, fontSize: 12, background: "var(--rpc-surface)", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 6 }}
            />
          </div>
          <Note>
            <b>{int(counts.backed)}</b> deal{counts.backed === 1 ? " is" : "s are"} also under the median of recent sales; <b>{int(counts.fmvOnly)}</b> ha
            {counts.fmvOnly === 1 ? "s" : "ve"} no sale in 30 days to check against and follow them.
            {filtering ? ` Showing ${int(shown.length)} of ${int(counts.total)} with your filters.` : ""}
          </Note>

          {shown.length === 0 ? (
            <div data-testid="panini-sniper-filtered-out" style={{ padding: "14px 16px", border: "1px dashed var(--rpc-border)", borderRadius: 8, marginTop: 10 }}>
              <Note>None of the {int(counts.total)} deals match these filters.</Note>
            </div>
          ) : (
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr>
                    {["Player", "Parallel", "Serial", "Ask", "FMV", "Under FMV", "Est. edge", "Recent sales", "Ask seen", ""].map((h, i) => (
                      <th key={i} style={th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const ek = paniniEditionKeyOfSku(r.sku)
                    const ext = paniniEditionUrl(ek)
                    return (
                      <tr key={r.sku}>
                        <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                          {ek ? (
                            <Link href={`/panini-blockchain/edition/${encodeURIComponent(ek)}`} style={{ color: "inherit" }}>
                              {r.player_name ?? "—"}
                            </Link>
                          ) : (
                            r.player_name ?? "—"
                          )}
                        </td>
                        <td style={td}>{r.parallel ?? "—"}</td>
                        <td style={td}>
                          {r.serial_number != null ? `#${r.serial_number}${r.mint_cap != null ? `/${r.mint_cap}` : ""}` : "—"}
                          {r.special_flag ? ` · ${r.special_flag}` : ""}
                        </td>
                        <td style={td}>{usd(r.ask_usd)}</td>
                        <td style={td}>{usd(r.fmv_usd)}</td>
                        <td style={td}>{r.discount_pct === null ? "—" : `${r.discount_pct}%`}</td>
                        <td style={td}>{usd(r.est_profit_usd)}</td>
                        <td style={td}>
                          {r.deal_basis === BACKED ? `median ${usd(r.recent_sales_median_usd)} (${int(r.recent_sales_n)})` : "none in 30 days"}
                        </td>
                        <td style={td}>{ptWhen(r.ask_confirmed_at, false)}</td>
                        <td style={td}>
                          {ext ? (
                            <a href={ext} target="_blank" rel="noopener noreferrer" style={{ color: "var(--rpc-text-primary)" }}>
                              View on Panini ↗
                            </a>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {data.dealsCapped ? (
            <div style={{ marginTop: 8 }}>
              <Note>
                The board keeps the top {int(counts.total)} deals — every sale-backed one first, then FMV-only ones by estimated edge. More FMV-only deals
                exist.
              </Note>
            </div>
          ) : null}
        </>
      )}
      <div style={{ marginTop: 12 }}>
        <Note>
          Est. edge is FMV minus the ask, before Panini&apos;s fees. RPC doesn&apos;t sell or buy cards — &ldquo;View on Panini&rdquo; opens the card&apos;s
          marketplace page.
        </Note>
      </div>
    </div>
  )
}
