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
export default function PinnacleCollectionPage() {
  return (
    <Suspense fallback={null}>
      <PinnacleCollectionClient />
    </Suspense>
  )
}
