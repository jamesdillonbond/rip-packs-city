// app/(collections)/[collection]/hot-floors/page.tsx
//
// "Hot Floors" — Top Shot editions whose floor is being actively SWEPT right now.
// Novel intelligence from the bulk-buy (Quick Buy) reverse-engineering: the
// get_topshot_hot_floors RPC sessionizes the Dapper Quick-Buy path per buyer and
// surfaces which editions are under the most sweep pressure (distinct sweepers,
// swept sales, swept spend) over the last few days — accumulation signal that
// neither Top Shot nor the Sets page shows. Server component, service-role RPC.

import Link from "next/link"
import { getCollection } from "@/lib/collections"
import { fetchHotFloors } from "@/lib/hot-floors/fetchers"

export const revalidate = 300


const TIER_COLOR: Record<string, string> = {
  COMMON: "#9ca3af",
  FANDOM: "#22d3ee",
  RARE: "#a78bfa",
  LEGENDARY: "#f59e0b",
  ULTIMATE: "#ef4444",
}

function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  return v < 1 ? `$${v.toFixed(2)}` : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function relTime(iso: string | null): string {
  if (!iso) return "—"
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return "—"
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export default async function HotFloorsPage(props: { params: Promise<{ collection: string }> }) {
  const { collection: collectionId } = await props.params
  const collection = getCollection(collectionId)
  const accent = collection?.accent ?? "var(--rpc-red)"

  // Top Shot-only feature (Quick-Buy proposer account is TS-specific).
  if (collectionId !== "nba-top-shot") {
    return (
      <div style={{ padding: "48px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: 14 }}>
        Hot Floors is a Top Shot feature. <Link href="/nba-top-shot/hot-floors" style={{ color: accent }}>View Top Shot Hot Floors →</Link>
      </div>
    )
  }

  // ⚠ The read lives in lib/ so it is BOUNDED and TESTABLE — see that module's
  // header. The `errored` distinction below is unchanged; what changed is that a
  // read which merely HANGS can now reach it.
  const { editions, ok } = await fetchHotFloors()
  const errored = !ok

  return (
    <div style={{ padding: "8px 0 40px" }}>
      <header style={{ marginBottom: 20 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 26, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: 0 }}>
          Hot Floors
        </h1>
        <p style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.6, margin: "8px 0 0", maxWidth: 720 }}>
          Editions whose floor is being actively <strong style={{ color: "var(--rpc-text-primary)" }}>swept</strong> — bought in bulk via Top Shot&rsquo;s Quick Buy over the last 3 days.
          Ranked by distinct sweepers. High sweep pressure on a common often precedes a floor move.
        </p>
      </header>

      {errored && (
        <div style={{ color: "#fecaca", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          Couldn&rsquo;t load hot floors right now. Try again shortly.
        </div>
      )}

      {!errored && editions.length === 0 && (
        <div style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13, padding: 16 }}>
          No active sweeps detected in the last 3 days.
        </div>
      )}

      {editions.length > 0 && (
        <div style={{ overflowX: "auto", border: "1px solid var(--rpc-border)", borderRadius: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 13, minWidth: 720 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 11 }}>
                <th style={{ padding: "10px 12px" }}>#</th>
                <th style={{ padding: "10px 12px" }}>Moment</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Sweepers</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Swept sales</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Swept $</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Avg paid</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Floor</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>FMV</th>
                <th style={{ padding: "10px 12px", textAlign: "right" }}>Last</th>
              </tr>
            </thead>
            <tbody>
              {editions.map((e, i) => {
                const tier = (e.tier ?? "").toUpperCase()
                return (
                  <tr key={e.external_id} style={{ borderTop: "1px solid var(--rpc-border)" }}>
                    <td style={{ padding: "10px 12px", color: "var(--rpc-text-muted)" }}>{i + 1}</td>
                    <td style={{ padding: "8px 12px" }}>
                      <Link href={`/nba-top-shot/edition/${encodeURIComponent(e.external_id)}`} style={{ display: "flex", alignItems: "center", gap: 10, color: "var(--rpc-text-primary)", textDecoration: "none" }}>
                        <span style={{ width: 34, height: 44, flexShrink: 0, borderRadius: 4, overflow: "hidden", background: "var(--rpc-surface-hover)", display: "inline-block" }}>
                          {e.thumbnail_url && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={e.thumbnail_url} alt="" width={34} height={44} style={{ objectFit: "cover", width: 34, height: 44 }} />
                          )}
                        </span>
                        <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                          <span style={{ fontWeight: 600 }}>{e.player_name ?? "—"}</span>
                          <span style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
                            {e.set_name ?? "—"}
                            {tier && (
                              <span style={{ marginLeft: 6, color: TIER_COLOR[tier] ?? "var(--rpc-text-muted)", fontWeight: 700 }}>{tier}</span>
                            )}
                          </span>
                        </span>
                      </Link>
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700, color: accent }}>{e.sweep_buyers}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{e.swept_sales}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{usd(e.swept_spend)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-primary)" }}>
                      {e.swept_sales > 0 && e.swept_spend != null ? usd(Number(e.swept_spend) / e.swept_sales) : "—"}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-secondary)" }}>{usd(e.floor_ask)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-muted)" }}>{usd(e.fmv_usd)}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", color: "var(--rpc-text-muted)" }}>{relTime(e.last_swept_at)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
