"use client"

// components/packs/PackContentsFallback.tsx
//
// Bounded fallback for the streamed "What's Inside" group on
// /[collection]/pack/dist/[distId].
//
// THE DEFECT THIS FIXES (verified live 2026-07-25). That group is an async server
// component behind <Suspense>, so its content ships in the tail of the initial
// response — there is no client request to watch, which is why the symptom looked
// like "zero API calls fired". The server side is healthy: `get_pack_contents`
// returns 24 rows in 67 ms for dist 1599 (≤731 ms across the 40 largest pools),
// and a full `curl` of the production page returns the completely rendered
// section, its hidden `<div id="S:1">` payload and the trailing
// `$RC("B:1","S:1")` completion script, in ~1.1 s. But in a real browser the page
// still sat on the fallback indefinitely — `document.readyState` "complete", the
// hidden segment present and unconsumed, no console error and no Sentry event. So
// the content is produced and delivered, and the client simply never swaps it in.
//
// Because the trigger is on the client stream-completion path rather than in our
// data path, the durable fix is to stop letting the fallback wait forever: this
// component is only mounted while the boundary is unresolved, so a timer that
// fires here is proof the swap did not happen. At that point it recovers the same
// rows over the existing public JSON route (`/api/entity/pack`, already the
// grid's own "Load more" endpoint), and if that fails too it says so plainly with
// a retry instead of spinning. An honest bounded failure beats an endless
// spinner, and this is robust to whatever stalls the swap — a truncated stream, a
// slow connection, an extension, a lambda timeout under contention.

import { useCallback, useEffect, useRef, useState } from "react"
import EditionsGridPaginated, { type EditionTile } from "@/components/entity/EditionsGridPaginated"

const CARD_STYLE: React.CSSProperties = {
  background: "rgba(13,13,13,0.92)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 8,
  padding: 18,
}

const MONO: React.CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11 }

// The server group normally resolves in ~1.1s. 9s is comfortably past any
// realistic streaming delay (including a cold pool read) while still well inside
// a visitor's patience, so a fire here means genuinely stalled, not merely slow.
const STALL_MS = 9_000

type Phase = "waiting" | "recovering" | "recovered" | "failed"

export default function PackContentsFallback({
  collection,
  distId,
  pageSize,
  label = "Loading pack contents…",
}: {
  /** Collection URL slug, e.g. "nba-top-shot". */
  collection: string
  distId: string
  pageSize: number
  label?: string
}) {
  const [phase, setPhase] = useState<Phase>("waiting")
  const [rows, setRows] = useState<EditionTile[]>([])
  const fetchUrl = `/api/entity/pack?collection=${encodeURIComponent(collection)}&dist_id=${encodeURIComponent(distId)}`
  // Guards against a retry racing an in-flight recovery, and against setting
  // state after the boundary resolved and unmounted us.
  const aliveRef = useRef(true)
  useEffect(() => () => { aliveRef.current = false }, [])

  const recover = useCallback(async () => {
    setPhase("recovering")
    try {
      const res = await fetch(`${fetchUrl}&offset=0&limit=${pageSize}`, { cache: "no-store" })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body: unknown = await res.json()
      if (!aliveRef.current) return
      if (Array.isArray(body) && body.length > 0) {
        setRows(body as EditionTile[])
        setPhase("recovered")
      } else {
        // A well-formed empty response is a real answer, not a failure to load:
        // this distribution has no indexed pullable pool.
        setRows([])
        setPhase("recovered")
      }
    } catch {
      if (aliveRef.current) setPhase("failed")
    }
  }, [fetchUrl, pageSize])

  useEffect(() => {
    const t = setTimeout(() => { void recover() }, STALL_MS)
    return () => clearTimeout(t)
  }, [recover])

  if (phase === "waiting" || phase === "recovering") {
    return (
      <section style={{ ...CARD_STYLE, ...MONO, color: "rgba(255,255,255,0.35)" }}>{label}</section>
    )
  }

  if (phase === "failed") {
    return (
      <section style={{ ...CARD_STYLE, ...MONO, color: "rgba(255,255,255,0.55)" }}>
        <div style={{ marginBottom: 8 }}>
          Couldn&apos;t load this pack&apos;s contents. The rest of the page is accurate — only this
          panel is missing.
        </div>
        <button
          type="button"
          onClick={() => { void recover() }}
          style={{
            ...MONO,
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.18)",
            borderRadius: 4,
            color: "#fff",
            cursor: "pointer",
            letterSpacing: "0.08em",
            padding: "6px 12px",
            textTransform: "uppercase",
          }}
        >
          Retry
        </button>
      </section>
    )
  }

  // recovered
  if (rows.length === 0) {
    return (
      <section style={{ ...CARD_STYLE, ...MONO, color: "rgba(255,255,255,0.4)" }}>
        Drop-pool contents aren&apos;t indexed for this distribution yet.
      </section>
    )
  }

  return (
    <section style={CARD_STYLE}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
        <h2
          style={{
            margin: 0,
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: 18,
            letterSpacing: "0.06em",
            color: "#fff",
            textTransform: "uppercase",
          }}
        >
          What&apos;s Inside
        </h2>
        <span style={{ ...MONO, fontSize: 10, color: "rgba(255,255,255,0.4)" }}>
          pullable editions
        </span>
      </div>
      <EditionsGridPaginated
        collectionUrlSlug={collection}
        fetchUrl={fetchUrl}
        initial={rows}
        pageSize={pageSize}
        showSetLink
        showSort
        packMode
      />
    </section>
  )
}
