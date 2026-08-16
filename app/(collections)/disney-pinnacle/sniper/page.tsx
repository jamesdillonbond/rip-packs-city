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
export default function PinnacleSniperPage() {
  return <PinnacleSniperClient />
}
