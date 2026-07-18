import type { ReactNode } from "react"
import Link from "next/link"
import { collectionHasPage, getCollection, PAGE_LABELS, type CollectionPage } from "@/lib/collections"

// FeatureTabGate — shared "this tab isn't available for this collection" shell
// (2026-07-18 IA reorg tab-gating consistency). Mirrors the packs/layout.tsx
// pattern so a direct URL to a tab a collection doesn't expose (e.g.
// /ufc/market, /disney-pinnacle/sets) renders a graceful pointer instead of a
// broken/empty core tab. When collectionHasPage passes, it's a transparent
// pass-through.
export default function FeatureTabGate({
  id,
  page,
  children,
}: {
  id: string
  page: CollectionPage
  children: ReactNode
}) {
  if (collectionHasPage(id, page)) return <>{children}</>

  const collection = getCollection(id)
  const label = collection?.label ?? "this collection"
  const pageLabel = PAGE_LABELS[page]
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "80px 24px", gap: 14 }}>
      <div style={{ fontSize: 48 }}>{collection?.icon ?? "\u{1F4E6}"}</div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 24, letterSpacing: "0.06em", color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>
        {pageLabel} isn&apos;t available for {label}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-muted)", lineHeight: 1.7, maxWidth: 460 }}>
        {label} doesn&apos;t expose the {pageLabel} tab yet. Use the Overview and Sniper tabs for live market state and deals.
      </div>
      <Link
        href={`/${id}/overview`}
        style={{ display: "inline-block", padding: "10px 24px", background: collection?.accent ?? "var(--rpc-red)", borderRadius: 6, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", textDecoration: "none", marginTop: 8 }}
      >
        Back to Overview
      </Link>
    </div>
  )
}
