"use client"
// components/onboarding/FirstRunTourMount.tsx
//
// Wrapper that fetches first-run state from /api/profile/first-run-tour
// and renders FirstRunTour conditionally. Drop this near the bottom of
// any authenticated page tree (dashboard is the canonical home) and the
// tour fires once per user — afterwards the GET returns completed=true
// and the wrapper renders nothing.
//
// ⚠ THE SERVER IS THE AUTHORITY. The device flag used to short-circuit the
// fetch, and localStorage is per-ORIGIN, not per-user: a second account
// signing in on the same browser inherited the first account's "done" and
// never saw the tour (observed 2026-09-02 on a brand-new signup). The flag is
// still written (FirstRunTour's dismiss uses it to cover the moment before
// the POST lands) but it no longer decides anything here. If the API cannot
// answer, nothing is shown — a tour is not worth guessing about.

import { useEffect, useState } from "react"
import FirstRunTour from "./FirstRunTour"

const DEVICE_FLAG = "rpc:first-run-completed"

export default function FirstRunTourMount() {
  const [shouldShow, setShouldShow] = useState(false)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    let cancelled = false

    fetch("/api/profile/first-run-tour", { cache: "no-store" })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled) return
        if (!j || typeof j.completed !== "boolean") {
          // The API did not answer the question — show nothing.
          setShouldShow(false)
          setResolved(true)
          return
        }
        const isCompleted = j.completed
        setShouldShow(!isCompleted)
        setResolved(true)
        try {
          if (isCompleted) localStorage.setItem(DEVICE_FLAG, "1")
          else localStorage.removeItem(DEVICE_FLAG)
        } catch { /* swallow */ }
      })
      .catch(() => {
        if (!cancelled) setResolved(true)
      })

    return () => { cancelled = true }
  }, [])

  if (!resolved || !shouldShow) return null

  return <FirstRunTour enabled={true} onDismiss={() => setShouldShow(false)} />
}
