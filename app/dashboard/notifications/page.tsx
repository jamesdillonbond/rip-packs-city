import { Suspense } from "react"
import type { Metadata } from "next"
import NotificationsClient from "./NotificationsClient"

export const metadata: Metadata = { title: "Email notifications", robots: { index: false, follow: false } }

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
        <main style={{ padding: "2rem", color: "var(--rpc-text-muted)", background: "var(--rpc-bg)", minHeight: "100vh", fontFamily: "var(--font-mono)" }}>
          Loading…
        </main>
      }
    >
      <NotificationsClient />
    </Suspense>
  )
}
