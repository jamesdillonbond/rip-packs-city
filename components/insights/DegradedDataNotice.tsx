// Honest degradation banner for the public /insights boards.
//
// Rendered ONLY when a backing query actually failed (summarizeDegraded returns null
// otherwise), so a healthy board is visually unchanged. See lib/insights/board-status.ts
// for why this exists: without it a statement timeout renders as an empty section at
// HTTP 200, and a reader cannot distinguish "nothing matched" from "we failed to ask".
//
// Deliberately a server-safe presentational component (no "use client", no hooks) so it
// costs nothing and can sit inside either a server page or a client board shell.

import type { DegradedSummary } from "@/lib/insights/board-status"

export default function DegradedDataNotice({ summary }: { summary: DegradedSummary | null }) {
  if (!summary) return null

  return (
    <div className="rpc-ins-degraded" role="status" aria-live="polite">
      <span className="rpc-ins-degraded-tag">Partial data</span>
      <p className="rpc-ins-degraded-copy">{summary.headline}</p>

      <style>{`
        .rpc-ins-degraded {
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 10px 14px;
          max-width: 1180px;
          margin: 0 auto 18px;
          padding: 12px 16px;
          border: 1px solid var(--rpc-red-border);
          border-left: 3px solid var(--rpc-red);
          border-radius: var(--radius-sm);
          background: rgba(224, 58, 47, 0.06);
        }
        .rpc-ins-degraded-tag {
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 2px;
          text-transform: uppercase;
          color: var(--rpc-red);
          white-space: nowrap;
        }
        .rpc-ins-degraded-copy {
          flex: 1;
          min-width: 260px;
          margin: 0;
          font-size: 13px;
          line-height: 1.55;
          color: var(--rpc-text-secondary);
        }
      `}</style>
    </div>
  )
}
