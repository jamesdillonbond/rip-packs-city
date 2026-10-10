"use client"

// app/insights/panini-premiums/PaniniPremiumsClient.tsx
//
// Client body of /insights/panini-premiums (2026-10-10): two tabs over the server's rows —
// Parallels (a numbered base parallel's FMV over the player's common base, same product) and
// Serials (real #1 / perfect-mint sales against the edition's typical sale) — with a sport filter
// and a player / product / parallel search, all in memory.
//
// Honesty rules:
//   · three states per tab — "couldn't load" (the server read failed), genuinely none, rows — and a
//     filter that hides every row says the FILTER did it
//   · parallels are HIGH/MEDIUM FMV on both sides (the server read's filter, stated here), and the
//     note says FMV is a model, not a sale
//   · serials are real sales from the sales RPC has read — a floor, not a census — and say so
//   · capped lists say they are capped; dates are absolute PT (no reader clock in render)
//   · RPC is read-only: rows link the edition page, nothing else

import { useMemo, useState, type CSSProperties } from "react"
import Link from "next/link"
import type { PaniniPremiumsPayload, PaniniParallelPremium, PaniniSerialPremium } from "@/lib/insights/panini-premiums"

type Tab = "parallels" | "serials"

const mono = "var(--font-mono)"
const display = "var(--font-display)"

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  return v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`
}
function mult(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  return v >= 10 ? `${Math.round(v).toLocaleString("en-US")}×` : `${v.toFixed(1)}×`
}
function cap(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : `/${Number(n).toLocaleString("en-US")}`
}
function ptWhen(iso: string | null, withTime: boolean): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  const opts: Intl.DateTimeFormatOptions = withTime
    ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" }
  return new Date(t).toLocaleString("en-US", opts) + (withTime ? " PT" : "")
}
function productLabel(r: { product_name: string | null; product_set_id: number | null }): string {
  return r.product_name ?? (r.product_set_id != null ? `Panini product ${r.product_set_id}` : "—")
}
function editionHref(externalId: string): string {
  return `/panini-blockchain/edition/${encodeURIComponent(externalId)}`
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}

const th: CSSProperties = { textAlign: "left", padding: "8px 10px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
const td: CSSProperties = { padding: "8px 10px", fontSize: 13, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
const chip = (on: boolean): CSSProperties => ({
  fontFamily: mono, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 12px", borderRadius: 6, cursor: "pointer",
  background: on ? "var(--rpc-red-bg)" : "transparent",
  border: `1px solid ${on ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
  color: on ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
})

function sportsOf(rows: { sport: string | null }[]): string[] {
  const n = new Map<string, number>()
  for (const r of rows) if (r.sport) n.set(r.sport, (n.get(r.sport) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s)
}

function matches(q: string, ...fields: (string | null | undefined)[]): boolean {
  if (!q) return true
  return fields.some((f) => (f ?? "").toLowerCase().includes(q))
}

export default function PaniniPremiumsClient({
  data,
  fetchedAt,
  failed,
}: {
  data: PaniniPremiumsPayload
  fetchedAt: string | null
  failed: boolean
}) {
  const [tab, setTab] = useState<Tab>("parallels")
  const [sport, setSport] = useState("")
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()

  const rowsForTab: { sport: string | null }[] = tab === "parallels" ? data.parallels : data.serials
  const sports = useMemo(() => sportsOf(rowsForTab), [rowsForTab])

  const parallels = useMemo(
    () => data.parallels.filter((r) => (!sport || r.sport === sport) && matches(q, r.player_name, r.parallel, r.product_name)),
    [data.parallels, sport, q],
  )
  const serials = useMemo(
    () => data.serials.filter((r) => (!sport || r.sport === sport) && matches(q, r.player_name, r.parallel, r.product_name)),
    [data.serials, sport, q],
  )
  const filtering = sport !== "" || q !== ""
  const total = tab === "parallels" ? data.parallels.length : data.serials.length
  const shown = tab === "parallels" ? parallels.length : serials.length

  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "16px 16px 40px" }}>
      <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 26, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 6px" }}>
        Panini Premiums
      </h1>
      <Note>
        What Panini&apos;s numbered parallels and headline serials are really worth, across soccer, NBA, NFL, WNBA and MLB products.
        {fetchedAt ? ` Read ${ptWhen(fetchedAt, true)}.` : ""}
      </Note>

      <div role="tablist" aria-label="Board" style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "14px 0 8px" }}>
        <button type="button" role="tab" aria-selected={tab === "parallels"} onClick={() => { setTab("parallels"); setSport("") }} style={chip(tab === "parallels")}>
          Parallels
        </button>
        <button type="button" role="tab" aria-selected={tab === "serials"} onClick={() => { setTab("serials"); setSport("") }} style={chip(tab === "serials")}>
          #1 &amp; perfect serials
        </button>
      </div>

      {tab === "parallels" ? (
        <Note>
          Each row is a numbered base parallel priced against the same player&apos;s most common base parallel in the same product — e.g. a Gold /10
          against the Silver. Both prices are RPC&apos;s FMV at HIGH or MEDIUM confidence (a model of recent sales and asks, not a sale), and only
          premiums of 1.5× or more are listed.
        </Note>
      ) : (
        <Note>
          Real sales in the last 90 days of an edition&apos;s #1 or its perfect mint (#N/N), against the median of that edition&apos;s other sales in
          the same window (at least 3 of them), at 2× or more. These are the sales RPC&apos;s Panini walk has read — a floor, not a census.
        </Note>
      )}

      {failed ? (
        <div role="alert" style={{ marginTop: 12, padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
          <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load the Panini premiums</div>
          <Note>The boards are unavailable right now. This is not the same as there being no premiums.</Note>
        </div>
      ) : total === 0 ? (
        <div data-testid="panini-premiums-none" style={{ marginTop: 12, padding: "14px 16px", border: "1px dashed var(--rpc-border)", borderRadius: 8 }}>
          <Note>{tab === "parallels" ? "No parallel clears 1.5× its base at HIGH/MEDIUM confidence right now." : "No #1 or perfect-mint sale in the last 90 days cleared 2× its edition's typical sale."}</Note>
        </div>
      ) : (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "12px 0 10px" }}>
            {sports.length > 1 ? (
              <div role="group" aria-label="Sport" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" aria-pressed={sport === ""} onClick={() => setSport("")} style={chip(sport === "")}>All sports</button>
                {sports.map((sp) => (
                  <button key={sp} type="button" aria-pressed={sport === sp} onClick={() => setSport(sp)} style={chip(sport === sp)}>
                    {sp}
                  </button>
                ))}
              </div>
            ) : null}
            <label htmlFor="panini-premiums-q" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
              Filter by player, parallel or product
            </label>
            <input
              id="panini-premiums-q"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Player, parallel or product"
              autoComplete="off"
              spellCheck={false}
              maxLength={60}
              style={{ flex: "1 1 180px", minWidth: 0, padding: "6px 10px", fontFamily: mono, fontSize: 12, background: "var(--rpc-surface)", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 6 }}
            />
          </div>
          {filtering ? <Note>Showing {shown.toLocaleString("en-US")} of {total.toLocaleString("en-US")} with your filters.</Note> : null}

          {shown === 0 ? (
            <div data-testid="panini-premiums-filtered-out" style={{ marginTop: 10, padding: "14px 16px", border: "1px dashed var(--rpc-border)", borderRadius: 8 }}>
              <Note>None of the {total.toLocaleString("en-US")} rows match these filters.</Note>
            </div>
          ) : tab === "parallels" ? (
            <ParallelTable rows={parallels} />
          ) : (
            <SerialTable rows={serials} />
          )}
          {(tab === "parallels" ? data.parallelsCapped : data.serialsCapped) ? (
            <div style={{ marginTop: 8 }}>
              <Note>The board keeps the top {total.toLocaleString("en-US")} by premium. More exist below them.</Note>
            </div>
          ) : null}
        </>
      )}
      <div style={{ marginTop: 12 }}>
        <Note>RPC doesn&apos;t sell or buy cards — each row opens the edition&apos;s page on RPC, which links to Panini&apos;s marketplace.</Note>
      </div>
    </div>
  )
}

function ParallelTable({ rows }: { rows: PaniniParallelPremium[] }) {
  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Player", "Product", "Parallel", "FMV", "Base", "Base FMV", "Premium"].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.external_id}>
              <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                <Link href={editionHref(r.external_id)} style={{ color: "inherit" }}>{r.player_name ?? "—"}</Link>
              </td>
              <td style={td}>
                {productLabel(r)}
                {r.sport ? <span style={{ color: "var(--rpc-text-muted)" }}> · {r.sport}</span> : null}
              </td>
              <td style={td}>{r.parallel ?? "—"}{cap(r.mint_cap)}</td>
              <td style={td}>{usd(r.parallel_fmv_usd)}</td>
              <td style={td}>{r.base_parallel ?? "—"}{cap(r.base_mint_cap)}</td>
              <td style={td}>{usd(r.base_fmv_usd)}</td>
              <td style={{ ...td, color: "var(--rpc-text-primary)", fontFamily: mono }}>{mult(r.premium_mult)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SerialTable({ rows }: { rows: PaniniSerialPremium[] }) {
  return (
    <div style={{ overflowX: "auto", marginTop: 10 }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Player", "Product", "Parallel", "Serial", "Sold for", "Typical sale", "Premium", "Sold"].map((h) => (
              <th key={h} style={th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.sku}|${r.sold_at ?? ""}`}>
              <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                <Link href={editionHref(r.external_id)} style={{ color: "inherit" }}>{r.player_name ?? "—"}</Link>
              </td>
              <td style={td}>
                {productLabel(r)}
                {r.sport ? <span style={{ color: "var(--rpc-text-muted)" }}> · {r.sport}</span> : null}
              </td>
              <td style={td}>{r.parallel ?? "—"}</td>
              <td style={td}>
                {r.serial_number != null ? `#${r.serial_number}${cap(r.mint_cap)}` : "—"}
                {r.headline ? ` · ${r.headline}` : ""}
              </td>
              <td style={td}>{usd(r.sale_usd)}</td>
              <td style={td}>
                {usd(r.edition_median_usd)}
                {r.edition_sales_n != null ? <span style={{ color: "var(--rpc-text-muted)" }}> ({r.edition_sales_n} sales)</span> : null}
              </td>
              <td style={{ ...td, color: "var(--rpc-text-primary)", fontFamily: mono }}>{mult(r.premium_mult)}</td>
              <td style={td}>{ptWhen(r.sold_at, false)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
