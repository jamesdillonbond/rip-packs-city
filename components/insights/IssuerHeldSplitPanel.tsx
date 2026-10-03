// components/insights/IssuerHeldSplitPanel.tsx
//
// "Issuer-held, split" panel on /insights/market-cap: Top Shot Moments the issuer
// still holds, divided into those inside unopened packs (sold or unsold) and reserve
// never put into any pack. Server-rendered (no hooks), RPC tokens only.
//
// Three states, never two: `failed` (the read died — say so), a split that is not
// provable yet (render its status, never a 0), and a known split.

import type { CSSProperties } from "react"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import { fmtCount } from "@/lib/insights/market-cap-format"
import { isSplitKnown, splitStatusCopy, tierLabel, type IssuerSplitRow } from "@/lib/insights/topshot-issuer-split-format"

const th = (align: "left" | "right"): CSSProperties => ({
  textAlign: align, padding: "10px 12px", fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em",
  textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap",
})
const td = (align: "left" | "right"): CSSProperties => ({
  textAlign: align, padding: "12px", borderBottom: "1px solid var(--rpc-border-subtle)", verticalAlign: "middle",
})

function Cell({ v, known }: { v: number | null; known: boolean }) {
  if (!known) return <span style={{ color: "var(--rpc-text-muted)" }}>—</span>
  return <>{fmtCount(v)}</>
}

export default function IssuerHeldSplitPanel({ rows, failed }: { rows: IssuerSplitRow[]; failed: boolean }) {
  const total = rows.find((r) => r.tier === null) ?? null
  const tiers = rows.filter((r) => r.tier !== null)
  const known = total != null && isSplitKnown(total)

  return (
    <section style={{ maxWidth: 1100, margin: "0 auto", padding: "0 16px 60px" }} aria-labelledby="issuer-split-h">
      <h2 id="issuer-split-h" style={{ margin: 0, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
        Top Shot issuer-held, split
      </h2>
      <p style={{ margin: "8px 0 0", maxWidth: 760, fontSize: 14, lineHeight: 1.5, color: "var(--rpc-text-secondary)" }}>
        Moments Top Shot still holds are left out of market cap. They are of two kinds: Moments sealed inside packs that
        exist and are unopened (sold or still for sale), and reserve that was minted but never put into any pack.
      </p>

      {failed || total == null ? (
        <div className="rpc-card" style={{ marginTop: 14, padding: 24, textAlign: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 13 }}>
          Couldn&apos;t load the issuer-held split just now — this is a failed read, not an empty result.
        </div>
      ) : (
        <>
          {!known && (
            <div className="rpc-card rpc-mono" style={{ marginTop: 14, padding: "12px 16px", fontSize: 12, color: "var(--rpc-text-secondary)" }}>
              {splitStatusCopy(total.split_status)}
            </div>
          )}
          <div className="rpc-card" style={{ marginTop: 14, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, color: "var(--rpc-text-primary)" }}>
              <thead>
                <tr>
                  <th style={th("left")}>Tier</th>
                  <th style={th("right")}>Issuer-held</th>
                  <th style={th("right")}>In unopened packs</th>
                  <th style={th("right")}>Reserve, never packed</th>
                </tr>
              </thead>
              <tbody>
                {[...tiers, total].map((r) => {
                  const k = isSplitKnown(r)
                  return (
                    <tr key={r.tier ?? "__total"} style={r.tier === null ? { fontWeight: 700 } : undefined}>
                      <td style={td("left")}>
                        {tierLabel(r.tier)}
                        {r.tier !== null && r.split_status !== "ok" && known && (
                          <span className="rpc-mono" style={{ marginLeft: 8, fontSize: 11, color: "var(--rpc-text-muted)" }}>{splitStatusCopy(r.split_status)}</span>
                        )}
                      </td>
                      <td style={td("right")} className="rpc-mono">{fmtCount(r.hidden)}</td>
                      <td style={td("right")} className="rpc-mono"><Cell v={r.in_packs} known={k} /></td>
                      <td style={td("right")} className="rpc-mono"><Cell v={r.reserve} known={k} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="rpc-mono" style={{ marginTop: 10, maxWidth: 820, fontSize: 11, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>
            {known && total.packs_unopened != null && (
              <>
                {fmtCount(total.packs_unopened)} unopened packs, {fmtCount(total.packs_owned_by_collectors)} of them already bought by collectors.{" "}
              </>
            )}
            Pack counts are Top Shot&apos;s own per-drop figures, read from the marketplace one drop at a time and refreshed daily;
            the split is as of <FreshnessStamp iso={known ? total.as_of : null} />.
            {total.editions_stale > 0 && (
              <> {fmtCount(total.editions_stale)} edition{total.editions_stale === 1 ? "" : "s"} whose issuer-held count has not refreshed in 36 hours
                ({fmtCount(total.hidden_stale)} Moments) {total.editions_stale === 1 ? "is" : "are"} left out of the issuer-held column.</>
            )}
          </p>
        </>
      )}
    </section>
  )
}
