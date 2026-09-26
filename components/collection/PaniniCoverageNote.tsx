// components/collection/PaniniCoverageNote.tsx
//
// The listing-gated coverage disclosure every shared Panini surface carries
// (published 2026-09-25 — Overview + Market). Panini publishes no checklist, so
// RPC indexes a card only once it has been LISTED for sale: every count, floor
// and price on these tabs is a floor, not a census. Same substance as the
// squeeze board's banner (app/insights/panini-squeeze/PaniniSqueezeClient.tsx).
//
// ⚠ The PRINCIPLE renders unconditionally. The figures come from
// panini_coverage_summary and are ADDED when the read succeeded; a failed read
// removes the numbers and says so — it never removes the disclosure, and never
// renders a missing figure as zero.

import type { PaniniCoverage } from "@/lib/panini/coverage"
import { formatCount } from "@/lib/format"

export default function PaniniCoverageNote({
  coverage,
  failed,
}: {
  coverage: PaniniCoverage | null | undefined
  failed?: boolean
}) {
  const days = (h: number | null) => (h == null ? null : Math.max(1, Math.round(h / 24)))
  const p50 = coverage ? days(coverage.edition_age_p50_h) : null
  const p90 = coverage ? days(coverage.edition_age_p90_h) : null
  return (
    <section
      className="rpc-card"
      data-testid="panini-coverage-note"
      style={{ padding: "12px 16px", borderLeft: "3px solid #C084FC" }}
    >
      <div className="rpc-label" style={{ marginBottom: 6 }}>Coverage — a floor, not a census</div>
      <div className="rpc-mono" style={{ fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
        Panini publishes no full checklist, so RPC sees a card only once it has been{" "}
        <b>listed for sale on Panini&rsquo;s marketplace</b>. Cards that have never been listed are invisible to us.
        {coverage ? (
          <>
            {" "}RPC indexes <b>{formatCount(coverage.total_editions)}</b> editions
            {coverage.listing_gated_editions != null && coverage.listing_gated_editions > 0 ? (
              <>
                ; <b>{formatCount(coverage.listing_gated_editions)}</b> of them sit in parallels we can see only while
                cards are listed
              </>
            ) : null}
            .
            {p50 != null ? (
              <>
                {" "}Prices are re-checked in rotation: the typical edition was last checked{" "}
                <b>{p50 === 1 ? "within a day" : `${p50} days ago`}</b>
                {p90 != null ? (
                  <>
                    , the oldest tenth <b>{p90 === 1 ? "within a day" : `${p90} days ago`}</b>
                  </>
                ) : null}
                .
              </>
            ) : null}
          </>
        ) : failed ? (
          <> Coverage figures couldn&rsquo;t be loaded right now.</>
        ) : null}{" "}
        Sale prices are not a complete feed: RPC records the last sale of each card it checks, not every sale.
      </div>
    </section>
  )
}
