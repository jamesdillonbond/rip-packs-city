import type { Metadata } from "next"
import { getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"
import { Suspense } from "react"
import PinnacleCollectionClient from "./PinnacleCollectionClient"

// Server wrapper. The interactive body lives in PinnacleCollectionClient.tsx so the
// component coverage gate measures it — a `page.tsx` is measured by NEITHER gate, which is
// why the "Total Pins: 0 out of a failed read" defect it carried survived until the split.
//
// ⚠ The Suspense boundary is HOISTED HERE rather than left inside the client. The body
// calls `useSearchParams`, which requires one — and leaving it inside would move the file
// into the coverage gate without making it renderable by a test, i.e. measurement with no
// assertions.
// 2026-09-25 — this tab inherited the segment layout's generic title ("Disney
// Pinnacle Analytics — Rip Packs City") and declared NO canonical, so the
// collection and sniper tabs shared one <title> and neither told a crawler which
// URL it was. Same builder the other collections' tabs use: the closed-market
// copy for Pinnacle, and a self-canonical.
export function generateMetadata(): Metadata {
  const c = getCollection("disney-pinnacle")!
  return pageMetadata("collection", c.label, c.id)
}

export default function PinnacleCollectionPage() {
  return (
    <Suspense fallback={null}>
      <PinnacleCollectionClient />
    </Suspense>
  )
}
