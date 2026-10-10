"use client"

// PaniniAnalytics — the Panini Analytics tab (/panini-blockchain/analytics, 2026-09-28).
// Server-seeded from panini_sales_analytics (migration 20260929023845) over panini_sales, the
// every-sale table fed from each edition's Top-20 / Recent-20 SALES HISTORY lists since
// 2026-09-28 (before that RPC kept only each card's newest sale).
//
// Honesty rules this component keeps:
//   · a day is COMPLETE only when >= COMPLETE_PCT of the editions that traded in the last 90
//     days have every sale of that day on record (per-day covered_pct, measured from the
//     Recent-list reads). A partial day draws NO bar — a partial day's height is exactly the
//     read-timing artefact that made the old last-sale series show a false ~90% collapse — and
//     its count is shown as "at least N" in the table view
//   · window totals say "at least" unless every day in the window is complete
//   · leaderboards say what they rank: sales RPC holds, not a census
//   · no buyer or seller handle is shown
//   · a failed read is "couldn't load", never zeros

import { useMemo, useState } from "react"
import Link from "next/link"
import { slugifyPlayerName } from "@/lib/entity-labels"

type Num = number | null

export interface PaniniDay { day: string; sales: number; volume_usd: Num; median_usd: Num; covered_pct: Num }
export interface PaniniSaleRow {
  sku: string
  edition_external_id: string
  sold_at: string
  amount_usd: number
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: Num
  mint_cap: Num
}
export interface PaniniTradedRow { edition_external_id: string; player_name: string | null; set_name: string | null; tier: string | null; sales: number; volume_usd: Num; median_usd: Num }
export interface PaniniPlayerRow { player_name: string; sales: number; volume_usd: Num; median_usd: Num; editions_traded: number }
export type PaniniSerialKind = "serial_1" | "last" | "serial_2_10" | "other"
export interface PaniniSerialPremiumRow { kind: PaniniSerialKind; print_run: string; sales: number; median_multiple: number; p25_multiple: Num; p75_multiple: Num }
export interface PaniniGroupRow { sales: number; volume_usd: Num; median_usd: Num; tier?: string; parallel?: string }
export interface PaniniSalesAnalytics {
  generated_at: string | null
  days: number
  coverage: {
    active_editions: number
    editions_read: number
    editions_whole_history: number
    editions_with_gaps: number
    first_read_at: string | null
    last_read_at: string | null
    sales_held: number
    sales_from_full_records: number
  }
  daily: PaniniDay[]
  window: { sales: number; volume_usd: Num; median_usd: Num; editions_traded: number; cards_traded: number }
  top_sales_window: PaniniSaleRow[]
  top_sales_all_time: PaniniSaleRow[]
  most_traded: PaniniTradedRow[]
  by_tier: PaniniGroupRow[]
  by_parallel: PaniniGroupRow[]
  /** null = this payload does not carry the list (the section is hidden), never "no sales". */
  by_player: PaniniPlayerRow[] | null
  /** null = this payload does not carry the table (the section is hidden). */
  serial_premium: PaniniSerialPremiumRow[] | null
}

/** The share of active editions whose sales RPC must hold for a day to count as complete. */
export const COMPLETE_PCT = 95

const mono = "var(--font-mono)"
const display = "var(--font-display)"

function usd(n: Num | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: n >= 100 ? 0 : 2 })
}
function int(n: Num | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}
/** PT calendar date for a "YYYY-MM-DD" day key (already a PT day) — no clock involved. */
function dayLabel(day: string): string {
  const [y, m, d] = day.split("-").map(Number)
  if (!y || !m || !d) return day
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
}
function ptWhen(iso: string | null, withTime = false): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  return (
    new Date(t).toLocaleString("en-US", {
      month: "short", day: "numeric", year: withTime ? undefined : "numeric",
      ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
      timeZone: "America/Los_Angeles",
    }) + (withTime ? " PT" : "")
  )
}
export function isCompleteDay(d: PaniniDay): boolean {
  return d.covered_pct != null && d.covered_pct >= COMPLETE_PCT
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={{ fontFamily: display, fontWeight: 800, fontSize: 16, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "28px 0 8px" }}>{children}</h2>
}
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: "12px 14px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{label}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)", marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>{sub}</div> : null}
    </div>
  )
}
const th: React.CSSProperties = { textAlign: "left", padding: "8px 10px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
const td: React.CSSProperties = { padding: "8px 10px", fontSize: 13, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>{head.map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
function editionHref(key: string) {
  return `/panini-blockchain/edition/${encodeURIComponent(key)}`
}
// A row whose edition is not in our catalogue has no player name (every one of the 7,208
// panini_editions rows has one; the name comes from that join), and no edition page:
// /panini-blockchain/edition/packcard-2305_4544702_12015358_1 was a 404 linked from this
// board (link crawl, 2026-09-29). Such a row shows its dash as plain text, not a dead link.
function EditionLink({ edition, name }: { edition: string; name: string | null }) {
  if (!name) return <>—</>
  return <Link href={editionHref(edition)} style={{ color: "inherit" }}>{name}</Link>
}
const SERIAL_KIND_LABEL: Record<PaniniSerialKind, string> = {
  serial_1: "#1",
  last: "Last serial (e.g. #25/25)",
  serial_2_10: "#2–10",
  other: "Every other serial",
}
function multiple(n: Num | undefined): string {
  return n == null ? "—" : `${n.toFixed(2)}×`
}
function playerHref(name: string) {
  return `/panini-blockchain/player/${encodeURIComponent(slugifyPlayerName(name))}`
}

/** Daily sales for COMPLETE days only; a partial day is an empty slot carrying its coverage. */
function DailyBars({ daily }: { daily: PaniniDay[] }) {
  const max = Math.max(1, ...daily.filter(isCompleteDay).map((d) => d.sales))
  return (
    <div role="img" aria-label="Sales per day, complete days only" style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 120, padding: "8px 0", borderBottom: "1px solid var(--rpc-border)" }}>
      {daily.map((d) => {
        const done = isCompleteDay(d)
        const tip = done
          ? `${dayLabel(d.day)}: ${int(d.sales)} sales · ${usd(d.volume_usd)} · median ${usd(d.median_usd)}`
          : `${dayLabel(d.day)}: not complete — ${d.covered_pct ?? 0}% of traded editions fully on record`
        return (
          <div key={d.day} title={tip} aria-label={tip} data-complete={done ? "true" : "false"} style={{ flex: "1 1 0", minWidth: 4, height: "100%", display: "flex", alignItems: "flex-end" }}>
            {done ? (
              <div style={{ width: "100%", height: `${Math.max(2, (d.sales / max) * 100)}%`, background: "var(--rpc-red)", borderRadius: "4px 4px 0 0" }} />
            ) : (
              <div style={{ width: "100%", height: 2, background: "var(--rpc-border)" }} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function PaniniAnalytics({ data }: { data: PaniniSalesAnalytics | null }) {
  const [allTime, setAllTime] = useState(false)
  const complete = useMemo(() => (data ? data.daily.filter(isCompleteDay) : []), [data])

  if (!data) {
    return (
      <Shell>
        <div role="alert" style={{ padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
          <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load Panini sales</div>
          <Note>Sales analytics are unavailable right now. This is not the same as there being no sales.</Note>
        </div>
      </Shell>
    )
  }

  const cov = data.coverage
  const windowComplete = data.daily.length > 0 && complete.length === data.daily.length
  const atLeast = windowComplete ? "" : "at least "
  const topRows = allTime ? data.top_sales_all_time : data.top_sales_window

  return (
    <Shell>
      <div role="note" style={{ padding: "10px 14px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 6, margin: "12px 0" }}>
        <Note>
          <b>How complete this is.</b> Since Sep 28 RPC keeps every Panini sale it reads — each card&apos;s top 20 and most recent 20 sales, re-read as the walk
          visits it. A day counts as complete once {COMPLETE_PCT}% of the editions that traded in the last 90 days have every sale of that day on record;
          until then it shows no bar and its counts read &ldquo;at least&rdquo;. {int(cov.editions_read)} editions read so far
          {cov.editions_whole_history > 0 ? ` (${int(cov.editions_whole_history)} with their whole sales history)` : ""}
          {cov.last_read_at ? `, last ${ptWhen(cov.last_read_at, true)}` : ""}; {int(cov.active_editions)} editions traded in the last 90 days.
          Sales are counted for every Panini product the walk reads.
          {/* 2026-10-10: this read "{editions_read} of {active_editions} traded editions read so far", but the
              two counts are different populations (every edition ever read vs the editions that traded in
              90 days), so production showed "21,655 of 11,534". It also said "Panini's World Cup set is the
              product RPC prices", untrue since the 09-28 multi-product walk. */}
        </Note>
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Tile label={`Sales · last ${data.days} days`} value={`${atLeast ? "≥ " : ""}${int(data.window.sales)}`} sub={windowComplete ? "complete" : `${complete.length} of ${data.daily.length} days complete`} />
        <Tile label="Volume" value={`${atLeast ? "≥ " : ""}${usd(data.window.volume_usd)}`} />
        <Tile label="Median sale" value={usd(data.window.median_usd)} sub={windowComplete ? undefined : "of the sales on record"} />
        <Tile label="Cards traded" value={`${atLeast ? "≥ " : ""}${int(data.window.cards_traded)}`} sub={`${int(data.window.editions_traded)} editions`} />
      </div>

      <H2>Sales per day</H2>
      {complete.length === 0 ? (
        <div data-testid="panini-analytics-building" style={{ padding: "14px 16px", border: "1px dashed var(--rpc-border)", borderRadius: 8 }}>
          <Note>
            No day is complete yet. RPC started keeping every sale on Sep 28; each day fills in once the walk has re-read the cards that traded on it. The
            counts below are sales on record, not totals.
          </Note>
        </div>
      ) : (
        <DailyBars daily={data.daily} />
      )}
      <details style={{ marginTop: 8 }}>
        <summary style={{ fontFamily: mono, fontSize: 12, color: "var(--rpc-text-secondary)", cursor: "pointer" }}>Daily table</summary>
        <Table head={["Day (PT)", "Sales", "Volume", "Median", "On record"]}>
          {[...data.daily].reverse().map((d) => {
            const done = isCompleteDay(d)
            return (
              <tr key={d.day}>
                <td style={td}>{dayLabel(d.day)}</td>
                <td style={td}>{done ? int(d.sales) : `≥ ${int(d.sales)}`}</td>
                <td style={td}>{done ? usd(d.volume_usd) : `≥ ${usd(d.volume_usd)}`}</td>
                <td style={td}>{usd(d.median_usd)}</td>
                <td style={td}>{done ? "complete" : `${d.covered_pct ?? 0}% of editions`}</td>
              </tr>
            )
          })}
        </Table>
      </details>

      <H2>Top sales</H2>
      <div role="tablist" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        {[false, true].map((at) => (
          <button
            key={String(at)}
            role="tab"
            aria-selected={allTime === at}
            onClick={() => setAllTime(at)}
            style={{
              fontFamily: mono, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", padding: "6px 12px", borderRadius: 6, cursor: "pointer",
              background: allTime === at ? "var(--rpc-red-bg)" : "transparent",
              border: `1px solid ${allTime === at ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
              color: allTime === at ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
            }}
          >
            {at ? "All time" : `Last ${data.days} days`}
          </button>
        ))}
      </div>
      {topRows.length === 0 ? (
        <Note>No sale on record in this window.</Note>
      ) : (
        <Table head={["Player", "Parallel", "Serial", "Price", "Sold (PT)"]}>
          {topRows.map((r) => (
            <tr key={`${r.sku}|${r.sold_at}`}>
              <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                <EditionLink edition={r.edition_external_id} name={r.player_name} />
              </td>
              <td style={td}>{r.set_name ?? "—"}</td>
              <td style={td}>{r.serial_number != null ? `#${r.serial_number}${r.mint_cap != null ? `/${r.mint_cap}` : ""}` : "—"}</td>
              <td style={td}>{usd(r.amount_usd)}</td>
              <td style={td}>{ptWhen(r.sold_at)}</td>
            </tr>
          ))}
        </Table>
      )}
      <Note>{allTime ? "The highest sales RPC holds — Panini's own top-20 list per card, plus earlier recorded sales." : "The highest sales RPC holds from these days."}</Note>

      <H2>Most traded editions · last {data.days} days</H2>
      {data.most_traded.length === 0 ? (
        <Note>No sale on record in this window.</Note>
      ) : (
        <Table head={["Player", "Parallel", "Sales", "Volume", "Median"]}>
          {data.most_traded.map((r) => (
            <tr key={r.edition_external_id}>
              <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                <EditionLink edition={r.edition_external_id} name={r.player_name} />
              </td>
              <td style={td}>{r.set_name ?? "—"}</td>
              <td style={td}>{`${atLeast ? "≥ " : ""}${int(r.sales)}`}</td>
              <td style={td}>{`${atLeast ? "≥ " : ""}${usd(r.volume_usd)}`}</td>
              <td style={td}>{usd(r.median_usd)}</td>
            </tr>
          ))}
        </Table>
      )}

      {data.by_player ? (<>
      <H2>Top players by volume · last {data.days} days</H2>
      {data.by_player.length === 0 ? (
        <Note>No sale on record in this window.</Note>
      ) : (
        <Table head={["Player", "Sales", "Volume", "Median", "Editions traded"]}>
          {data.by_player.map((r) => (
            <tr key={r.player_name}>
              <td style={{ ...td, color: "var(--rpc-text-primary)" }}>
                <Link href={playerHref(r.player_name)} style={{ color: "inherit" }}>{r.player_name}</Link>
              </td>
              <td style={td}>{`${atLeast ? "≥ " : ""}${int(r.sales)}`}</td>
              <td style={td}>{`${atLeast ? "≥ " : ""}${usd(r.volume_usd)}`}</td>
              <td style={td}>{usd(r.median_usd)}</td>
              <td style={td}>{`${atLeast ? "≥ " : ""}${int(r.editions_traded)}`}</td>
            </tr>
          ))}
        </Table>
      )}
      <Note>Players ranked by the sales RPC holds from these days; cards outside RPC&apos;s catalogue are not in this list.</Note>
      </>) : null}

      {data.serial_premium && data.serial_premium.length > 0 ? (<>
      <H2>Serial premiums · all sales on record</H2>
      <Table head={["Print run", "Serial", "Sales", "Typical price", "Middle half"]}>
        {data.serial_premium.map((r) => (
          <tr key={`${r.print_run}|${r.kind}`} data-serial-kind={r.kind}>
            <td style={td}>/{r.print_run}</td>
            <td style={{ ...td, color: "var(--rpc-text-primary)" }}>{SERIAL_KIND_LABEL[r.kind]}</td>
            <td style={td}>{int(r.sales)}</td>
            <td style={td}>{multiple(r.median_multiple)}</td>
            <td style={td}>{r.p25_multiple != null && r.p75_multiple != null ? `${multiple(r.p25_multiple)} – ${multiple(r.p75_multiple)}` : "—"}</td>
          </tr>
        ))}
      </Table>
      <Note>
        What a serial sells for as a multiple of the same card&apos;s usual price — the median of its other sales, excluding #1 and the last serial, on
        cards with at least 3 such sales on record. 1.00× means no premium. A typical multiple, not a price for any one card.
      </Note>
      </>) : null}

      <H2>By rarity · last {data.days} days</H2>
      <Table head={["Rarity", "Sales", "Volume", "Median"]}>
        {data.by_tier.map((r) => (
          <tr key={r.tier}>
            <td style={td}>{r.tier === "UNKNOWN" ? "Not in RPC's catalogue" : (r.tier ?? "—").charAt(0) + (r.tier ?? "").slice(1).toLowerCase()}</td>
            <td style={td}>{`${atLeast ? "≥ " : ""}${int(r.sales)}`}</td>
            <td style={td}>{`${atLeast ? "≥ " : ""}${usd(r.volume_usd)}`}</td>
            <td style={td}>{usd(r.median_usd)}</td>
          </tr>
        ))}
      </Table>

      <H2>Top parallels by volume · last {data.days} days</H2>
      <Table head={["Parallel", "Sales", "Volume", "Median"]}>
        {data.by_parallel.map((r) => (
          <tr key={r.parallel}>
            <td style={td}>{r.parallel}</td>
            <td style={td}>{`${atLeast ? "≥ " : ""}${int(r.sales)}`}</td>
            <td style={td}>{`${atLeast ? "≥ " : ""}${usd(r.volume_usd)}`}</td>
            <td style={td}>{usd(r.median_usd)}</td>
          </tr>
        ))}
      </Table>
      {data.generated_at ? (
        <div style={{ marginTop: 12 }}>
          <Note>Computed {ptWhen(data.generated_at, true)}; refreshes about every 5 minutes.</Note>
        </div>
      ) : null}
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 1180, margin: "0 auto", padding: "16px 16px 40px" }}>
      <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 6px" }}>
        Panini — Sales Analytics
      </h1>
      {children}
    </div>
  )
}
