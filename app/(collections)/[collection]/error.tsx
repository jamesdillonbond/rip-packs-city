"use client"

import { useEffect } from "react"
import { useParams } from "next/navigation"

// Brand error boundary for EVERY page under /[collection]/** — set, team, player,
// play, edition, moment, series, sets, badges, market, and the rest.
//
// ── WHY (deep-audit R19) ────────────────────────────────────────────────────
// `/nba-top-shot/set/base-set` and `/nba-top-shot/team/los-angeles-lakers` were
// observed returning Next's DEFAULT error page — a bare, unbranded
// "This page couldn't load — A server error occurred." with the document title
// "500: This page couldn't load". Both are linked directly from the public
// `/nba-top-shot/overview` catalog. Small siblings never failed across the same
// sweep, so this is a heavy read blowing its budget under DB load, not a code
// path that is always broken.
//
// Every other public surface on this site degrades honestly and in brand. These
// bailed to a page that is off-brand, says nothing useful, and offers no way
// back. Before this file only TWO error boundaries existed in the whole app:
// `pack/dist/[distId]/error.tsx` and the root `global-error.tsx`.
//
// ⚠ PLACED AT THE COLLECTION SEGMENT, NOT PER PAGE. A boundary added to `set/`
// and `team/` — the two routes that were observed failing — would be the
// "fix per PANEL, not per page" mistake that turned D12 into D12b: the next
// heavy entity page would bail to Next's default exactly as before. Nesting
// this at the segment root means a route added tomorrow inherits it.
//
// ⚠ WHAT THIS DOES NOT DO. It does not make the page work, and it must never
// imply the DATA is empty — the read failed, which is a claim about US, not
// about the market. It says the page did not render and offers a retry.
export default function CollectionSegmentError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // console.log, NOT console.warn — warn is not indexed in Vercel runtime logs,
    // so a warn here would make this class unsearchable after the fact.
    console.log("[collection-segment-error]", {
      name: error.name,
      message: error.message,
      digest: error.digest,
      stack: error.stack,
    })
  }, [error])

  const params = useParams<{ collection?: string }>()
  const collection = typeof params?.collection === "string" ? params.collection : null
  // Fall back to the site root rather than guessing a collection slug — a
  // fabricated link is worse than a generic one.
  const backHref = collection ? `/${collection}/overview` : "/"

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
          // Tokens, not a hardcoded neutral: --rpc-text-* are THEME-AWARE, and a
          // hardcoded rgba(255,255,255,…) renders invisible in light mode.
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

      {/* ⚠ Reports, does not conclude. "We couldn't load it" is a claim about US;
          "there is nothing here" would be a claim about the MARKET. */}
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
        <a
          href={backHref}
          style={{
            padding: "10px 18px",
            border: "1px solid var(--rpc-red-border)",
            color: "var(--rpc-red)",
            background: "transparent",
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.2em",
            textTransform: "uppercase",
            fontSize: 12,
            textDecoration: "none",
          }}
        >
          Back to overview
        </a>
      </div>

      {error.digest ? (
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--rpc-text-ghost)",
            marginTop: 4,
          }}
        >
          ref {error.digest}
        </div>
      ) : null}
    </main>
  )
}
