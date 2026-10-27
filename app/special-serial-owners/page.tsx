import SpecialSerialOwnersClient, { boardSeed } from "./SpecialSerialOwnersClient"

// Server wrapper. The interactive body lives in SpecialSerialOwnersClient.tsx so the
// component coverage gate measures it (`vitest.components.config.ts` includes
// `app/**/*Client.tsx`; a `page.tsx` is measured by NEITHER gate).
//
// As with the Pinnacle sniper page, the split is what made the KPI band's honesty testable
// — and the band was publishing "0 special serials / 0 distinct holders" out of a failed
// read while the list directly below it said "Failed to load".
//
// 2026-10-26: the page seeds the board from `?player=` / `?collection=` (edition pages link both). It read
// none before, so "See who holds X's special serials" opened the unfiltered Top Shot board. Read server-side
// from `searchParams` (no useSearchParams, so no Suspense boundary); the board is sign-in only and per-viewer.
export default async function SpecialSerialOwnersPage(props: { searchParams: Promise<{ player?: string | string[]; collection?: string | string[] }> }) {
  const seed = boardSeed(await props.searchParams)
  return <SpecialSerialOwnersClient initialPlayer={seed.player} initialCollection={seed.collection} />
}
