import type { Metadata } from "next"
import { getCollection } from "@/lib/collections"
import { pageMetadata } from "@/lib/seo"
import PinnacleSniperClient from "./PinnacleSniperClient"

// Server wrapper. The interactive body lives in PinnacleSniperClient.tsx so the
// component coverage gate measures it — `vitest.components.config.ts` includes
// `app/**/*Client.tsx`, and a `page.tsx` is measured by NEITHER gate (the primary gate's
// include stops at `app/**/route.ts`).
//
// That mattered here beyond bookkeeping: the split is what made the stats bar's honesty
// testable at all, and the bar was publishing "0 pins" and "FMV coverage: 0 editions" on a
// failed first load — two claims manufactured from our own outage, rendered directly ABOVE
// the FEED ERROR banner that was the page's only honest surface.
//
// No Suspense boundary is needed: this page reads no search params.
// 2026-09-25 — this tab inherited the segment layout's generic title ("Disney
// Pinnacle Analytics — Rip Packs City") and declared NO canonical, so the
// collection and sniper tabs shared one <title> and neither told a crawler which
// URL it was. Same builder the other collections' tabs use: the closed-market
// copy for Pinnacle, and a self-canonical.
export function generateMetadata(): Metadata {
  const c = getCollection("disney-pinnacle")!
  return pageMetadata("sniper", c.label, c.id)
}

export default function PinnacleSniperPage() {
  return <PinnacleSniperClient />
}
