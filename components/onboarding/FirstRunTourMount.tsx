"use client"
// components/onboarding/FirstRunTourMount.tsx
//
// Wrapper that fetches first-run state from /api/profile/first-run-tour
// and renders FirstRunTour conditionally. Drop this near the bottom of
// any authenticated page tree (dashboard is the canonical home) and the
// tour fires once per user — afterwards the GET returns completed=true
// and the wrapper renders nothing. localStorage is a one-session fallback
// for the moment between dismissal and the API write landing.

import { useEffect, useState } from "react"
import FirstRunTour from "./FirstRunTour"

export default function FirstRunTourMount() {
  const [shouldShow, setShouldShow] = useState(false)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    let cancelled = false

    // Fast-path: if localStorage already says we're done, skip the fetch.
    try {
      if (localStorage.getItem("rpc:first-run-completed") === "1") {
        setResolved(true)
        setShouldShow(false)
        return
      }
    } catch { /* private mode — fall through */ }

    fetch("/api/profile/first-run-tour", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled) return
        const isCompleted = !!(j && j.completed)
        setShouldShow(!isCompleted)
        setResolved(true)
        if (isCompleted) {
          try { localStorage.setItem("rpc:first-run-completed", "1") } catch { /* swallow */ }
        }
      })
      .catch(() => {
        if (!cancelled) setResolved(true)
      })

    return () => { cancelled = true }
  }, [])

  if (!resolved || !shouldShow) return null

  return <FirstRunTour enabled={true} onDismiss={() => setShouldShow(false)} />
}
