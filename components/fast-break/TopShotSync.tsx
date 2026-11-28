"use client"
// components/fast-break/TopShotSync.tsx
//
// Two halves of "Sync from Top Shot" on RPC's Fast Break page:
//   * TopShotSyncReceiver — when the page opens with #topshot-sync=<payload> (put there by the
//     reader running on the collector's own nbatopshot.com/fastbreak tab), POST it to
//     /api/fast-break/topshot-sync, clear the fragment, refresh the page's data.
//   * TopShotSyncCard — explains the sync and offers the reader as a bookmarklet.
// The fragment never leaves the browser except in that same-origin POST, which carries the
// collector's own session — the server takes the user and wallet from the session, not the body.

import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { SYNC_HASH_PREFIX, topShotBookmarklet } from "@/lib/fast-break/topshot-sync"

type SyncState =
  | { kind: "idle" }
  | { kind: "syncing" }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string }

const NOTE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--rpc-text-secondary)",
}

export function TopShotSyncReceiver() {
  const router = useRouter()
  const [state, setState] = useState<SyncState>({ kind: "idle" })
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    const hash = typeof window === "undefined" ? "" : window.location.hash
    if (!hash.startsWith(SYNC_HASH_PREFIX)) return
    started.current = true
    // Clear the fragment first so a reload never re-posts it.
    window.history.replaceState(null, "", window.location.pathname + window.location.search)
    ;(async () => {
      let payload: unknown
      try {
        payload = JSON.parse(decodeURIComponent(hash.slice(SYNC_HASH_PREFIX.length)))
      } catch {
        setState({ kind: "error", text: "The Top Shot sync data was unreadable — run the sync again." })
        return
      }
      setState({ kind: "syncing" })
      try {
        const res = await fetch("/api/fast-break/topshot-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          setState({ kind: "error", text: `Sync failed (${String(json?.error ?? res.status).replace(/_/g, " ")}). Nothing on your account changed.` })
          return
        }
        const r = json?.result ?? {}
        setState({
          kind: "done",
          text: `Synced ${r.run ?? "the run"}: ${r.nights_upserted ?? 0} nights, ${r.cards ?? 0} players with their plays left${json?.walletPinned ? "" : " (pin your Top Shot wallet to track uses)"}.`,
        })
        router.refresh()
      } catch {
        setState({ kind: "error", text: "Sync failed — the request didn't reach RPC. Nothing on your account changed." })
      }
    })()
  }, [router])

  if (state.kind === "idle") return null
  return (
    <div role="status" style={{ ...NOTE, padding: "10px 14px", marginBottom: 16, borderRadius: "var(--radius-md)", border: "1px solid var(--rpc-border)", background: "rgba(255,255,255,0.03)", color: state.kind === "error" ? "var(--rpc-red-text, var(--rpc-red-fill))" : "var(--rpc-text-secondary)" }}>
      {state.kind === "syncing" ? "Syncing from Top Shot…" : state.text}
    </div>
  )
}

export function TopShotSyncCard() {
  const link = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    // React refuses javascript: URLs in JSX; a bookmarklet has to be set on the element.
    link.current?.setAttribute("href", topShotBookmarklet())
  }, [])
  return (
    <div style={{ marginTop: 20, padding: 16, border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-lg)" }}>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 13, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-secondary)", marginBottom: 8 }}>
        Sync from Top Shot
      </div>
      <div style={NOTE}>
        RPC can&apos;t see the plays you&apos;ve already made or which of your Moments a Pro night allows — Top Shot shows those only to you. Drag this button to your bookmarks bar, open{" "}
        <a href="https://nbatopshot.com/fastbreak" target="_blank" rel="noreferrer" style={{ color: "var(--rpc-text-primary)" }}>Top Shot Fast Break</a>{" "}
        (Classic or Pro), and click the bookmark. It reads the page and brings you back here with your run, tonight&apos;s targets and your plays left.
      </div>
      {/* href starts as the Top Shot page (a real link before hydration); the effect swaps
          in the bookmarklet. Clicked here on RPC, the reader says to open Top Shot first. */}
      <a
        ref={link}
        href="https://nbatopshot.com/fastbreak"
        style={{
          display: "inline-block", marginTop: 12, cursor: "grab", padding: "8px 14px",
          border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-sm)",
          fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em",
          textTransform: "uppercase", color: "var(--rpc-text-primary)", textDecoration: "none",
        }}
      >
        Sync from Top Shot
      </a>
    </div>
  )
}
