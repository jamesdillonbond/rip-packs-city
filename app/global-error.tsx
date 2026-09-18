// app/global-error.tsx — last-resort error boundary for the root layout
"use client"

import { useEffect } from "react"
import { clientErrorPayload, pageSessionId } from "@/components/telemetry/ClientErrorBeacon"

// Where a root-layout crash gets RECORDED. Until 2026-09-18 this called
// Sentry.captureException — a collector that had stored nothing since
// 2026-08-18 (known-issues #34). The client-side record that actually exists
// is the beacon's `usage_events.client_error` row (proven on prod 09-06 and
// 09-08), so this boundary posts the same payload the beacon would. Next's
// `digest` is the only way to tie a user's crash to the server log line, so it
// rides in `source`. Best-effort and silent on failure, like the beacon.
export function reportGlobalError(error: Error & { digest?: string }): void {
  try {
    const body = JSON.stringify(
      clientErrorPayload({
        kind: "error",
        message: error.message,
        source: error.digest ? `global-error:${error.digest}` : "global-error",
        stack: error.stack,
        path: typeof location !== "undefined" ? location.pathname : "",
        width: typeof window !== "undefined" ? window.innerWidth : 0,
        ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
        sid: pageSessionId(),
      }),
    )
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      if (navigator.sendBeacon("/api/telemetry", new Blob([body], { type: "application/json" }))) return
    }
    void fetch("/api/telemetry", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {})
  } catch {
    // Reporting must never throw inside the boundary that reports.
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    reportGlobalError(error)
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
