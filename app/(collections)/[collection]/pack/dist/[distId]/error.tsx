"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"
import { reportBoundaryError } from "@/components/telemetry/ClientErrorBeacon"

export default function PackDistError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.log("[pack-dist-error]", {
      name: error.name,
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    })
    // Also RECORD it: a boundary-caught error never reaches window.onerror, so
    // without this the beacon misses every crash this page shows (2026-10-11).
    reportBoundaryError(error, "pack-dist-error")
  }, [error])

  // 2026-10-11: the link was hardcoded to /nba-top-shot/packs, so an All Day or
  // Golazos reader was sent to the wrong collection. Use the route's own slug;
  // fall back to the site root rather than guess one.
  const params = useParams<{ collection?: string }>()
  const packsHref = typeof params?.collection === "string" ? `/${params.collection}/packs` : "/"

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
        Pack page error
      </div>
      <h1
        style={{
          fontFamily: "var(--font-display)",
          fontWeight: 900,
          fontSize: "clamp(32px, 6vw, 56px)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--rpc-text-primary)",
          margin: 0,
          textAlign: "center",
        }}
      >
        Couldn&rsquo;t render this pack
      </h1>
      <p
        style={{
          color: "var(--rpc-text-secondary)",
          maxWidth: 480,
          textAlign: "center",
          margin: 0,
        }}
      >
        We logged the failure. Reload to try again, or head back to the pack index.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
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
        <a
          href={packsHref}
          style={{
            padding: "10px 18px",
            border: "1px solid var(--rpc-red)",
            color: "var(--rpc-red-text)",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          All packs
        </a>
      </div>
    </main>
  )
}
