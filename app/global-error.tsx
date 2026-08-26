// app/global-error.tsx — Sentry error boundary for the root layout
"use client"

import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html lang="en" className="dark">
      <body style={{
        background: "#000",
        color: "#f4f4f5",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        textAlign: "center",
        padding: "2rem",
      }}>
        {/* brand-exception: global-error renders its own <html>, outside the app layout that loads rpc-tokens.css — CSS vars don't resolve here */}
        <div style={{ maxWidth: 420 }}>
          <h1 style={{ fontSize: "1.5rem", marginBottom: "0.5rem", color: "#E03A2F" }}>
            Something went wrong
          </h1>
          {/* ⚠ Reports what we DID, never what a human will do about it. This used to
              read "Our team has been notified." — a promise whose truth depended on
              Sentry actually STORING the event, which it stopped doing on
              2026-08-18 (org error quota exhausted; the decision is not to buy more).
              The capture below still runs and is still worth running, but "we tried to
              report it" and "a person has seen it" are different claims and only the
              first is ours to make. Voice matches the sibling boundary at
              app/(collections)/[collection]/error.tsx ("We logged it. Reloading often
              works."), which already got this right. */}
          <p style={{ color: "#a1a1aa", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            An unexpected error occurred. We logged it — trying again often works.
          </p>
          <button
            onClick={reset}
            style={{
              background: "#E03A2F", // brand-exception: see above — global-error renders outside the token CSS
              color: "#000",
              border: "none",
              padding: "0.75rem 2rem",
              borderRadius: "0.5rem",
              fontSize: "1rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try Again
          </button>
        </div>
      </body>
    </html>
  )
}
