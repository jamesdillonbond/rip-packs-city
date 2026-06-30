// app/insights/allday-pack-market/page.tsx
//
// PUBLIC INSIGHTS — NFL All Day Pack Market (sealed-pack secondary resale).
//
// Server-rendered board: what a SEALED All Day pack actually trades for on the
// secondary market, vs its original retail price. Reads v_allday_pack_market
// (complete Dapper Studio Platform sale history, backfilling to AllDay's 2022
// genesis) directly via supabaseAdmin so the ranked rows are crawlable. Gated on
// n_sales >= 5 so the resale signal is stable.
//
// This is genuinely novel — Top Shot's own site never surfaces what an unopened
// pack resells for, or whether it trades above or below the price it dropped at.

import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"

export const revalidate = 600

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

interface MarketRow {
  dist_id: string
  title: string | null
  drop_size: number | string | null
  retail_price: number | string | null
  opened_pct_of_minted: number | string | null
  n_sales: number | string | null
  n_sales_90d: number | string | null
  last_sale_price: number | string | null
  last_sale_at: string | null
  median_price_90d: number | string | null
  secondary_vs_retail_ratio: number | string | null
}

function num(v: number | string | null | undefined): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function fmtUsd(v: number | null): string {
  if (v == null) return "—"
  if (Math.abs(v) >= 100) return `$${Math.round(v).toLocaleString()}`
  return `$${v.toFixed(2)}`
}
function fmtCount(v: number | null): string {
  if (v == null) return "—"
  return Math.round(v).toLocaleString()
}
function fmtRatio(v: number | null): string {
  if (v == null) return "—"
  return `${v.toFixed(2)}×`
}

interface Buckets {
  discount: MarketRow[]
  premium: MarketRow[]
  mostTraded: MarketRow[]
  qualifying: number
  lastSaleAt: string | null
}

async function fetchBuckets(): Promise<Buckets> {
  const { data, error } = await sb
    .from("v_allday_pack_market")
    .select(
      "dist_id, title, drop_size, retail_price, opened_pct_of_minted, n_sales, n_sales_90d, last_sale_price, last_sale_at, median_price_90d, secondary_vs_retail_ratio",
    )
    .gte("n_sales", 5)
    .limit(1000)
  if (error) {
    console.error("[insights/allday-pack-market] market", error.message)
    return { discount: [], premium: [], mostTraded: [], qualifying: 0, lastSaleAt: null }
  }
  const rows = (data ?? []) as MarketRow[]
  const ratio = (r: MarketRow) => num(r.secondary_vs_retail_ratio)
  const priced = rows.filter((r) => (num(r.retail_price) ?? 0) > 0 && ratio(r) != null)
  const discount = priced
    .filter((r) => (ratio(r) ?? 1) < 0.85)
    .sort((a, b) => (ratio(a) ?? 9) - (ratio(b) ?? 9))
    .slice(0, 15)
  const premium = priced
    .filter((r) => (ratio(r) ?? 0) > 1.15)
    .sort((a, b) => (ratio(b) ?? 0) - (ratio(a) ?? 0))
    .slice(0, 15)
  const mostTraded = rows
    .slice()
    .sort((a, b) => (num(b.n_sales) ?? 0) - (num(a.n_sales) ?? 0))
    .slice(0, 15)
  const lastSaleAt =
    rows
      .map((r) => r.last_sale_at)
      .filter((d): d is string => !!d)
      .sort()
      .pop() ?? null
  return { discount, premium, mostTraded, qualifying: rows.length, lastSaleAt }
}

function freshnessLabel(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const cardStyle: React.CSSProperties = {
  background: "rgba(13,13,13,0.92)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 18,
}

function MarketTable({ rows, accent, showRatio }: { rows: MarketRow[]; accent: string; showRatio: boolean }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "rgba(255,255,255,0.45)", textAlign: "left" }}>
            <th style={{ padding: "6px 10px", fontWeight: 600 }}>Pack</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Retail</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Median 90d</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Last</th>
            {showRatio ? (
              <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>vs retail</th>
            ) : null}
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Sales</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const opened = num(r.opened_pct_of_minted)
            return (
              <tr key={r.dist_id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                <td style={{ padding: "8px 10px" }}>
                  <Link
                    href={`/nfl-all-day/pack/dist/${encodeURIComponent(r.dist_id)}`}
                    style={{ color: "rgba(255,255,255,0.9)", textDecoration: "none" }}
                  >
                    {r.title ?? `Dist ${r.dist_id}`}
                  </Link>
                </td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.6)" }}>{fmtUsd(num(r.retail_price))}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.85)", fontWeight: 700 }}>{fmtUsd(num(r.median_price_90d))}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.6)" }}>{fmtUsd(num(r.last_sale_price))}</td>
                {showRatio ? (
                  <td style={{ padding: "8px 10px", textAlign: "right", color: accent, fontWeight: 700 }}>{fmtRatio(num(r.secondary_vs_retail_ratio))}</td>
                ) : null}
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.55)" }}>{fmtCount(num(r.n_sales))}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.5)" }}>{opened != null ? `${opened.toFixed(opened >= 10 ? 0 : 1)}%` : "—"}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Bucket({
  title,
  blurb,
  rows,
  accent,
  showRatio,
}: {
  title: string
  blurb: string
  rows: MarketRow[]
  accent: string
  showRatio: boolean
}) {
  if (rows.length === 0) return null
  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 18, letterSpacing: "0.05em", color: "#fff", textTransform: "uppercase" }}>
          {title}
        </h2>
        <span style={{ width: 8, height: 8, borderRadius: "50%", background: accent, display: "inline-block" }} aria-hidden="true" />
      </div>
      <p style={{ margin: "0 0 12px", fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.5)", lineHeight: 1.5 }}>{blurb}</p>
      <MarketTable rows={rows} accent={accent} showRatio={showRatio} />
    </section>
  )
}

export default async function AllDayPackMarketPage() {
  const { discount, premium, mostTraded, qualifying, lastSaleAt } = await fetchBuckets()
  const hasData = discount.length + premium.length + mostTraded.length > 0

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "#fff", textTransform: "uppercase", lineHeight: 1.05 }}>
          All Day Pack Market
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.55, maxWidth: 720 }}>
          What a <strong>sealed</strong> NFL All Day pack actually trades for — and whether it resells above or below the
          price it dropped at. We roll up the complete on-chain secondary sale history of unopened packs and rank them by
          discount-to-retail, resale premium, and trading volume. Only packs with 5+ secondary sales qualify.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 999, padding: "3px 10px" }}>
            ● Last sale {freshnessLabel(lastSaleAt)}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {qualifying} qualifying dist{qualifying === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {hasData ? (
        <>
          <Bucket
            title="Trading below retail"
            blurb="Sealed packs reselling for the biggest discount to their original drop price — most All Day packs settle below retail once the drop hype fades."
            rows={discount}
            accent="rgb(252,211,77)"
            showRatio
          />
          <Bucket
            title="Trading above retail"
            blurb="The rare packs the market pays a premium for — sealed resale above the original drop price, usually low-supply or chase-heavy pools."
            rows={premium}
            accent="rgb(110,231,183)"
            showRatio
          />
          <Bucket
            title="Most traded"
            blurb="The most liquid sealed-pack markets by total secondary sales — where the resale price is the most reliable read."
            rows={mostTraded}
            accent="rgba(255,255,255,0.85)"
            showRatio={false}
          />
        </>
      ) : (
        <section style={cardStyle}>
          <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
            Still gathering sales. The complete sealed-pack sale history is backfilling to NFL All Day&rsquo;s 2022 genesis —
            packs appear here once we&rsquo;ve recorded 5+ secondary sales. Check back shortly.
          </p>
          <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.6 }}>
            In the meantime, see the{" "}
            <Link href="/insights/allday-pack-reality" style={{ color: "var(--rpc-red)", textDecoration: "none" }}>
              All Day Pack Reality board
            </Link>{" "}
            for what opened packs actually pull.
          </p>
        </section>
      )}

      {/* ── Methodology / footer ──────────────────────────────────────────── */}
      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: secondary resale of <strong>sealed</strong> (unopened) packs only, from the complete on-chain sale
          history via <code>v_allday_pack_market</code>. Median 90d is the trailing-90-day median secondary price; vs
          retail = median 90d ÷ the pack&rsquo;s original drop price (reward/airdrop packs with $0 retail have no ratio and
          appear only under Most traded). Prices are DUC ≈ USD. Opened % is the authoritative complete depletion across
          all minted packs.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>
            ← All insights
          </Link>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent("NFL All Day Pack Market — what sealed packs actually resell for, above or below retail.")}&url=${encodeURIComponent(`${SITE_URL}/insights/allday-pack-market`)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}
          >
            Share on X
          </a>
        </div>
      </footer>
    </div>
  )
}
