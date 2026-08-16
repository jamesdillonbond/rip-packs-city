import BetaActivityClient from "./BetaActivityClient"

// Server wrapper. The interactive body lives in BetaActivityClient.tsx so the component
// coverage gate measures it — `vitest.components.config.ts` includes `app/**/*Client.tsx`,
// and a `page.tsx` is measured by NEITHER gate.
//
// This page reads no search params, so no Suspense boundary is required.
export default function BetaActivityPage() {
  return <BetaActivityClient />
}
