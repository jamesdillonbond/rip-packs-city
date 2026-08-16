import SpecialSerialOwnersClient from "./SpecialSerialOwnersClient"

// Server wrapper. The interactive body lives in SpecialSerialOwnersClient.tsx so the
// component coverage gate measures it (`vitest.components.config.ts` includes
// `app/**/*Client.tsx`; a `page.tsx` is measured by NEITHER gate).
//
// As with the Pinnacle sniper page, the split is what made the KPI band's honesty testable
// — and the band was publishing "0 special serials / 0 distinct holders" out of a failed
// read while the list directly below it said "Failed to load".
//
// No Suspense boundary is needed: this page reads no search params.
export default function SpecialSerialOwnersPage() {
  return <SpecialSerialOwnersClient />
}
