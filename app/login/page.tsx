// app/login/page.tsx
//
// Thin server shell. The form body lives in LoginClient.tsx, which the component
// coverage gate measures (`app/**/*Client.tsx`); a `page.tsx` matches NEITHER
// gate's include, which is the entire reason for the split.
//
// ⚠ THE SUSPENSE BOUNDARY IS HOISTED HERE DELIBERATELY. LoginClient calls
// `useSearchParams`, which Next.js requires be wrapped — but a boundary left
// INSIDE the client file moves it into the coverage gate without making it
// renderable by a test, because the test then mounts the fallback and asserts
// against a blank div. Keeping the boundary in the server shell is what makes
// the split testable rather than merely measured.

import type { Metadata } from "next"
import { Suspense } from "react"
import LoginClient from "./LoginClient"

// The tab read as the generic site title ("Rip Packs City — The Intelligence
// Layer…") until 2026-09-04; the root template appends " | Rip Packs City".
// A sign-in form is not a page to index.
export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: true },
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: "100vh", background: "#080808" }} />}>
      <LoginClient />
    </Suspense>
  )
}
