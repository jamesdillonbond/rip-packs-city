// app/(collections)/[collection]/sniper/page.tsx
//
// Thin server shell. The feed body lives in SniperClient.tsx, which the
// component coverage gate measures (`app/**/*Client.tsx`); a `page.tsx` matches
// NEITHER gate's include, which is the entire reason for the split.
//
// ⚠ THE SUSPENSE BOUNDARY IS HOISTED HERE DELIBERATELY. SniperClient calls
// `useSearchParams` (for the Moments|Packs sub-toggle), which Next.js requires
// be wrapped — but a boundary left INSIDE the client file moves it into the
// coverage gate without making it renderable by a test, because the test then
// mounts the fallback and asserts against a loading string.

import { Suspense } from "react"
import SniperClient from "./SniperClient"

export default function SniperPage() {
  return (
    <Suspense
      fallback={
        <div className="rpc-mono" style={{ padding: 24, color: "var(--rpc-text-muted)" }}>
          Loading sniper…
        </div>
      }
    >
      <SniperClient />
    </Suspense>
  )
}
