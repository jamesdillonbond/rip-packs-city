// components/marketplace-status/FlowtyDormancyChip.tsx
//
// Subtle informational chip shown above listings lists when the collection
// is otherwise healthy but its Flowty secondary venue is dormant (i.e.
// secondary_status === "dormant_*"). Helps users understand why competing
// listings may look thin compared to historical norms.

"use client"

import { useMarketplaceStatus } from "./useMarketplaceStatus"

interface Props {
  /** Hyphen slug (e.g. "nba-top-shot", "nfl-all-day"). */
  collectionSlug: string
}

export default function FlowtyDormancyChip({ collectionSlug }: Props) {
  const { status, loaded } = useMarketplaceStatus(collectionSlug)
  if (!loaded || !status) return null
  // Only render the "currently offline" note when the rest of the collection
  // is healthy — for shutdown / unknown the top-of-page banner already
  // communicates the broader problem and a Flowty-specific chip would be noise.
  if (status.status !== "healthy") return null
  const dormant = (status.secondaryStatus ?? "").startsWith("dormant")
  if (!dormant) return null

  return (
    <div
      role="note"
      className="rpc-mono"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        background: "rgba(59,130,246,0.08)",
        border: "1px solid rgba(59,130,246,0.25)",
        borderRadius: "var(--radius-sm)",
        color: "var(--rpc-info)",
        fontSize: "var(--text-xs)",
        letterSpacing: "0.04em",
      }}
      title="Flowty marketplace has been dormant since May 14, 2026."
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", opacity: 0.6 }} />
      Flowty marketplace currently offline
    </div>
  )
}
