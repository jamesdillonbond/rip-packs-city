"use client"

import { useEffect } from "react"

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
          color: "rgba(255,255,255,0.45)",
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
          color: "#fff",
          margin: 0,
          textAlign: "center",
        }}
      >
        Couldn&rsquo;t render this pack
      </h1>
      <p
        style={{
          color: "rgba(255,255,255,0.65)",
          maxWidth: 480,
          textAlign: "center",
          margin: 0,
        }}
      >
        We logged the failure. Reload to try again, or head back to the pack index.
      </p>
      <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
        <button
          onClick={() => reset()}
          style={{
            padding: "10px 18px",
            border: "1px solid rgba(255,255,255,0.2)",
            color: "#fff",
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
          href="/nba-top-shot/packs"
          style={{
            padding: "10px 18px",
            border: "1px solid var(--rpc-red)",
            color: "var(--rpc-red)",
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
