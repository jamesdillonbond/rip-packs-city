import Link from "next/link"
import SpecialSerialOwnersClient from "./SpecialSerialOwnersClient"
import { boardSeed } from "./board-seed"

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
  if (seed.collection === null) {
    // A collection this board does not cover: refuse, never another collection's holders (board-seed.ts).
    return (
      <div data-testid="sso-unsupported-collection" style={{ padding: "48px 16px", maxWidth: 720, margin: "0 auto", fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
        The special-serial holders board covers NBA Top Shot and NFL All Day only.{" "}
        <Link href="/special-serial-owners" style={{ color: "var(--rpc-text-primary)" }}>Top Shot</Link>
        {" · "}
        <Link href="/special-serial-owners?collection=nfl-all-day" style={{ color: "var(--rpc-text-primary)" }}>NFL All Day</Link>
      </div>
    )
  }
  return <SpecialSerialOwnersClient initialPlayer={seed.player} initialCollection={seed.collection} />
}
