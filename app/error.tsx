"use client"

import { useEffect } from "react"
import Link from "next/link"
import { reportBoundaryError } from "@/components/telemetry/ClientErrorBeacon"

// Root route error boundary (2026-10-11).
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Only /[collection]/** had a segment boundary. A render error anywhere else —
// every /insights board, /dashboard, /profile, /alerts, /my-teams, /giveaways —
// fell through to app/global-error.tsx, which REPLACES THE ROOT LAYOUT: the
// header, the mobile nav and the concierge all vanish, leaving a page with one
// link. This boundary sits inside the root layout, so the chrome survives and
// the reader can navigate away or retry.
//
// It also RECORDS the crash. React does not re-raise a boundary-caught error to
// window.onerror, so ClientErrorBeacon's listener never sees it; without the
// report below these crashes would be recorded nowhere.
//
// ⚠ Same contract as the collection boundary: it reports OUR failure and never
// implies the data is empty, and it does not promise a human was notified.
export default function RootRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // console.log, NOT console.warn — warn is not indexed in Vercel runtime logs.
    console.log("[root-route-error]", {
      name: error.name,
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    })
    reportBoundaryError(error, "root-route-error")
  }, [error])

  return (
    <main
      style={{
        minHeight: "60vh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        gap: 16,
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          letterSpacing: "0.3em",
          textTransform: "uppercase",
          color: "var(--rpc-text-muted)",
        }}
      >
        Page error
      </div>

      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 900,
          fontSize: "clamp(28px, 5vw, 48px)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--rpc-text-primary)",
          margin: 0,
          textAlign: "center",
        }}
      >
        Couldn&rsquo;t render this page
      </h1>

      <p
        style={{
          color: "var(--rpc-text-secondary)",
          maxWidth: 520,
          textAlign: "center",
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        Something failed while building this page, so nothing is shown rather than a partial or
        misleading view. This is a problem on our side — it does not mean the data is missing. We
        logged it. Reloading often works.
      </p>

      <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            padding: "10px 18px",
            border: "1px solid var(--rpc-border)",
            color: "var(--rpc-text-primary)",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          Reload
        </button>
        <Link
          href="/"
          style={{
            padding: "10px 18px",
            border: "1px solid var(--rpc-red-border)",
            color: "var(--rpc-red-text)",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          Back to home
        </Link>
      </div>

      {error.digest ? (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--rpc-text-muted)",
            marginTop: 4,
          }}
        >
          ref {error.digest}
        </div>
      ) : null}
    </main>
  )
}
