import { Suspense } from "react"
import NotificationsClient from "./NotificationsClient"

// Thin server wrapper. The body lives in NotificationsClient.tsx so that
// `app/**/*Client.tsx` — which IS in the component gate's coverage include —
// measures it; a `"use client"` page.tsx is matched by neither gate.
//
// ⚠ The Suspense boundary is REQUIRED and belongs here, not inside the client:
// NotificationsClient calls `useSearchParams`, which Next needs a boundary
// around or the whole route opts out of static rendering. Hoisting it also
// means the client component can be rendered directly by a test.
export default function NotificationsPage() {
  return (
    <Suspense
      fallback={
        <main style={{ padding: "2rem", color: "#fafafa", background: "#0a0a0a", minHeight: "100vh" }}>
          Loading…
        </main>
      }
    >
      <NotificationsClient />
    </Suspense>
  )
}
