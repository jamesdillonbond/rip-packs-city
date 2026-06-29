// app/insights/allday-pack-reality/page.tsx
//
// PUBLIC INSIGHTS — NFL All Day Pack Reality (model vs realized pulls).
//
// Server-rendered honesty board: "the model says $X, packs actually pull $Y."
// Reads v_allday_pack_realized_ev (the AllDay sibling of the TS realized-EV
// view) directly via supabaseAdmin so the ranked rows are crawlable. Gated on
// n_opens >= 5 with low-confidence (stale-FMV) dists excluded, matching the
// /api/public/insights/allday-pack-reality endpoint.
//
// The view is sparse today — it populates as resolve-allday-pack-dist
// attributes opened packs to PAID distributions. Until a paid dist clears the
// open threshold the board renders an honest "still gathering" empty state.

import Link from "next/link"
import { supabaseAdmin } from "@/lib/supabase"

export const revalidate = 600

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

interface RealizedRow {
  dist_id: string
  title: string | null
  pack_price: number | string | null
  modeled_gross_ev: number | string | null
  ev_method: string | null
  n_opens: number | string | null
  n_valued: number | string | null
  realized_mean: number | string | null
  realized_median: number | string | null
  realized_to_modeled_ratio: number | string | null
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

interface Buckets {
  over: RealizedRow[]
  under: RealizedRow[]
  onModel: RealizedRow[]
  qualifying: number
  fetchedAt: string
}

async function fetchBuckets(): Promise<Buckets> {
  const { data, error } = await sb
    .from("v_allday_pack_realized_ev")
    .select(
      "dist_id, title, pack_price, modeled_gross_ev, ev_method, n_opens, n_valued, realized_mean, realized_median, realized_to_modeled_ratio",
    )
    .gte("n_opens", 5)
    .eq("low_confidence_ev", false)
    .limit(1000)
  const fetchedAt = new Date().toISOString()
  if (error) {
    console.error("[insights/allday-pack-reality] realized", error.message)
    return { over: [], under: [], onModel: [], qualifying: 0, fetchedAt }
  }
  const rows = (data ?? []) as RealizedRow[]
  const priced = rows.filter((r) => (num(r.pack_price) ?? 0) > 0 && num(r.modeled_gross_ev) != null)
  const ratio = (r: RealizedRow) => num(r.realized_to_modeled_ratio)
  const nonFossil = (r: RealizedRow) => {
    const ev = num(r.modeled_gross_ev)
    const price = num(r.pack_price)
    return ev != null && price != null && ev <= price * 1.5
  }
  const over = priced
    .filter((r) => nonFossil(r) && (ratio(r) ?? 99) < 0.6 && (num(r.modeled_gross_ev) ?? 0) >= 2)
    .sort((a, b) => (ratio(a) ?? 99) - (ratio(b) ?? 99))
    .slice(0, 12)
  const under = priced
    .filter((r) => (ratio(r) ?? 0) > 1.8 && (num(r.modeled_gross_ev) ?? 0) >= 0.5)
    .sort((a, b) => (ratio(b) ?? 0) - (ratio(a) ?? 0))
    .slice(0, 12)
  const onModel = priced
    .filter((r) => (ratio(r) ?? 0) >= 0.8 && (ratio(r) ?? 0) <= 1.25)
    .sort((a, b) => (num(b.n_opens) ?? 0) - (num(a.n_opens) ?? 0))
    .slice(0, 12)
  return { over, under, onModel, qualifying: priced.length, fetchedAt }
}

function freshnessLabel(iso: string): string {
  const then = new Date(iso).getTime()
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000))
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  return `${hrs}h ago`
}

const cardStyle: React.CSSProperties = {
  background: "rgba(13,13,13,0.92)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 18,
}

function RealizedTable({ rows, accent }: { rows: RealizedRow[]; accent: string }) {
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "rgba(255,255,255,0.45)", textAlign: "left" }}>
            <th style={{ padding: "6px 10px", fontWeight: 600 }}>Pack</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Model EV</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Realized avg</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Median</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Ratio</th>
            <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Opens</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ratio = num(r.realized_to_modeled_ratio)
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
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.75)" }}>{fmtUsd(num(r.modeled_gross_ev))}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: accent, fontWeight: 700 }}>{fmtUsd(num(r.realized_mean))}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.6)" }}>{fmtUsd(num(r.realized_median))}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: accent }}>{ratio != null ? `${ratio.toFixed(2)}×` : "—"}</td>
                <td style={{ padding: "8px 10px", textAlign: "right", color: "rgba(255,255,255,0.55)" }}>{fmtCount(num(r.n_opens))}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Bucket({ title, blurb, rows, accent }: { title: string; blurb: string; rows: RealizedRow[]; accent: string }) {
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
      <RealizedTable rows={rows} accent={accent} />
    </section>
  )
}

export default async function AllDayPackRealityPage() {
  const { over, under, onModel, qualifying, fetchedAt } = await fetchBuckets()
  const hasData = over.length + under.length + onModel.length > 0

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "28px 18px 64px", display: "flex", flexDirection: "column", gap: 16 }}>
      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <header style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.22em", textTransform: "uppercase", color: "var(--rpc-red)" }}>
          RPC Insights · Public
        </span>
        <h1 style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 38, letterSpacing: "0.02em", color: "#fff", textTransform: "uppercase", lineHeight: 1.05 }}>
          All Day Pack Reality
        </h1>
        <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "rgba(255,255,255,0.65)", lineHeight: 1.55, maxWidth: 720 }}>
          The model says one number — opened packs pull another. We compare each NFL All Day pack&rsquo;s odds-corrected
          expected value against the value its packs <strong>actually delivered</strong>, resolved on-chain from real
          opens. Thin and stale-FMV dists are excluded; only packs with 5+ observed opens qualify.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(255,255,255,0.45)", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 999, padding: "3px 10px" }}>
            ● Updated {freshnessLabel(fetchedAt)}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
            {qualifying} qualifying dist{qualifying === 1 ? "" : "s"}
          </span>
        </div>
      </header>

      {hasData ? (
        <>
          <Bucket
            title="Model over-values"
            blurb="The corrected model expected more than these packs actually pulled — buyer beware, the headline EV runs hot."
            rows={over}
            accent="rgb(248,113,113)"
          />
          <Bucket
            title="Model under-values"
            blurb="These packs out-pulled their modeled EV — the model was conservative on what came out."
            rows={under}
            accent="rgb(110,231,183)"
          />
          <Bucket
            title="Model tracks reality"
            blurb="Modeled EV and realized pulls line up within a quarter — the EV here is trustworthy."
            rows={onModel}
            accent="rgba(255,255,255,0.85)"
          />
        </>
      ) : (
        <section style={cardStyle}>
          <p style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
            Still gathering opens. NFL All Day primary pack sales have ended, so this reality-check fills in as opened
            secondary packs get attributed to their paid distribution. Once a paid pack clears 5 observed opens it
            appears here with its model-vs-reality verdict.
          </p>
          <p style={{ margin: "12px 0 0", fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.45)", lineHeight: 1.6 }}>
            In the meantime, see the{" "}
            <Link href="/insights/pack-reality" style={{ color: "var(--rpc-red)", textDecoration: "none" }}>
              Top Shot Pack Reality board
            </Link>{" "}
            for the same audit on a fully-attributed collection.
          </p>
        </section>
      )}

      {/* ── Methodology / footer ──────────────────────────────────────────── */}
      <footer style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "rgba(255,255,255,0.4)", lineHeight: 1.7 }}>
        <p style={{ margin: 0 }}>
          Method: modeled EV is the odds/median-corrected value from <code>v_allday_pack_info</code> (tiers valued by
          median FMV, weighted by published pack odds or circulation share). Realized value is the on-chain pull value of
          opened packs attributed to each distribution. Ratio = realized mean ÷ modeled EV. Realized value rides on
          AllDay FMV, which is thin — low-confidence (stale-FMV) dists are excluded from this board.
        </p>
        <div style={{ marginTop: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
          <Link href="/insights" style={{ color: "rgba(255,255,255,0.6)", textDecoration: "none" }}>
            ← All insights
          </Link>
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent("NFL All Day Pack Reality — what the model says vs what packs actually pull.")}&url=${encodeURIComponent(`${SITE_URL}/insights/allday-pack-reality`)}`}
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
