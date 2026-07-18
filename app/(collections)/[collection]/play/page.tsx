// app/(collections)/[collection]/play/page.tsx
//
// "Play" — the Top Shot game-tools hub (2026-07-18 IA reorg). Collects
// Challenges (live) + Fast Break + Road to the Ring (built, currently parked).
// Play is in Top Shot's `pages` array only; other collections get a graceful
// pointer. Server component — <PlayHub/> is static link cards.

import Link from "next/link"
import { collectionHasPage, getCollection } from "@/lib/collections"
import PlayHub from "@/components/play/PlayHub"

export const revalidate = 300

export default async function PlayPage(props: { params: Promise<{ collection: string }> }) {
  const { collection } = await props.params
  const coll = getCollection(collection)
  const accent = coll?.accent ?? "var(--rpc-red)"

  if (!coll || !collectionHasPage(collection, "play")) {
    return (
      <div style={{ padding: "48px 8px", color: "var(--rpc-text-secondary)", fontFamily: "var(--font-mono)", fontSize: 14 }}>
        Play is a Top Shot feature.{" "}
        <Link href="/nba-top-shot/play" style={{ color: accent }}>
          View Top Shot Play →
        </Link>
      </div>
    )
  }

  return <PlayHub collection={collection} accent={accent} />
}
