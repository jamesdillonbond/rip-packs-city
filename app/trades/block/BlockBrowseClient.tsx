"use client"

// app/trades/block/BlockBrowseClient.tsx
//
// The public Trade Block: open listings, newest first, filterable by collection and by a
// player / character / set. Four states, never collapsed: loading · could not load ·
// none match · the list. A failed read is a banner with Retry — never "no listings".

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import type { ListingView } from "@/lib/trade-block/view"
import { BLOCK_COLLECTION_FILTERS, ListingCard } from "./block-ui"
import { btn, btnPrimary, call, card, DISPLAY, errorOf, MONO, muted } from "../trade-ui"

type Load =
  | { kind: "loading" }
  | { kind: "error"; error: string }
  | { kind: "ok"; listings: ListingView[]; next: string | null; more: boolean }

function url(collection: string, q: string, before: string | null): string {
  const sp = new URLSearchParams()
  if (collection) sp.set("collection", collection)
  if (q.trim()) sp.set("q", q.trim())
  if (before) sp.set("before", before)
  const s = sp.toString()
  return `/api/public/trade-block${s ? `?${s}` : ""}`
}

export default function BlockBrowseClient() {
  const [collection, setCollection] = useState("")
  const [q, setQ] = useState("")
  const [applied, setApplied] = useState({ collection: "", q: "" })
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [moreError, setMoreError] = useState<string | null>(null)

  const read = useCallback(async (f: { collection: string; q: string }) => {
    setLoad({ kind: "loading" })
    const r = await call(url(f.collection, f.q, null))
    if (!r.ok || !Array.isArray(r.body?.listings)) return setLoad({ kind: "error", error: r.ok ? "The response had no listings in it." : errorOf(r) })
    const next = typeof r.body.next_before === "string" ? r.body.next_before : null
    setLoad({ kind: "ok", listings: r.body.listings as ListingView[], next, more: false })
  }, [])

  useEffect(() => {
    let live = true
    // a deep link (/trades/block?collection=…&q=…, e.g. from a player page) starts filtered;
    // an unknown collection is passed through and refused by the route, never dropped silently
    const sp = new URLSearchParams(window.location.search)
    const initial = { collection: sp.get("collection") ?? "", q: (sp.get("q") ?? "").slice(0, 80) }
    void call(url(initial.collection, initial.q, null)).then((r) => {
      if (!live) return
      if (initial.collection || initial.q) {
        setCollection(initial.collection)
        setQ(initial.q)
        setApplied(initial)
      }
      if (!r.ok || !Array.isArray(r.body?.listings)) return setLoad({ kind: "error", error: r.ok ? "The response had no listings in it." : errorOf(r) })
      setLoad({ kind: "ok", listings: r.body.listings as ListingView[], next: typeof r.body.next_before === "string" ? r.body.next_before : null, more: false })
    })
    return () => {
      live = false
    }
  }, [])

  const apply = (e?: React.FormEvent) => {
    e?.preventDefault()
    const f = { collection, q }
    setApplied(f)
    void read(f)
  }

  const loadMore = async () => {
    if (load.kind !== "ok" || !load.next) return
    setMoreError(null)
    setLoad({ ...load, more: true })
    const r = await call(url(applied.collection, applied.q, load.next))
    if (!r.ok || !Array.isArray(r.body?.listings)) {
      setMoreError(r.ok ? "The response had no listings in it." : errorOf(r))
      return setLoad({ ...load, more: false })
    }
    setLoad({
      kind: "ok",
      listings: [...load.listings, ...(r.body.listings as ListingView[])],
      next: typeof r.body.next_before === "string" ? r.body.next_before : null,
      more: false,
    })
  }

  const filtered = applied.collection !== "" || applied.q.trim() !== ""

  return (
    <main id="content" style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 0, flex: "1 1 320px" }}>
          <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 4px", fontSize: 28 }}>Trade Block</h1>
          <p style={{ ...muted, margin: 0, fontSize: 14 }}>
            What collectors would trade, and what they want back. Asset for asset — no cash. When both sides are NBA Top Shot, an accepted proposal opens a
            trade room where both wallets sign one transaction.
          </p>
        </div>
        <Link href="/trades/block/mine" style={{ ...btnPrimary, textDecoration: "none", display: "inline-block" }}>
          Post a listing
        </Link>
      </div>

      <form onSubmit={apply} style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Collection
          <select
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--rpc-border)", background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", fontFamily: MONO, fontSize: 13 }}
          >
            {BLOCK_COLLECTION_FILTERS.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 200px", fontSize: 11, color: "var(--rpc-text-muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          Player, character or set
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. Wembanyama"
            style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--rpc-border)", background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", fontFamily: MONO, fontSize: 13 }}
          />
        </label>
        <button type="submit" style={{ ...btn, alignSelf: "flex-end" }}>
          Search
        </button>
      </form>

      {load.kind === "loading" ? (
        <p style={muted}>Loading the Trade Block…</p>
      ) : load.kind === "error" ? (
        <section style={{ ...card, borderColor: "var(--rpc-danger-text)" }}>
          <p style={{ margin: "0 0 8px", color: "var(--rpc-danger-text)", fontSize: 13 }}>Couldn&apos;t load the Trade Block: {load.error}</p>
          <button type="button" style={btn} onClick={() => void read(applied)}>
            Retry
          </button>
        </section>
      ) : load.listings.length === 0 ? (
        <section style={card}>
          <p style={{ ...muted, margin: 0 }}>
            {filtered ? "No open listings match that search." : "No open listings yet."}{" "}
            <Link href="/trades/block/mine">Post the first one.</Link>
          </p>
        </section>
      ) : (
        <>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            {load.listings.map((l) => (
              <li key={l.code}>
                <ListingCard l={l} href={`/trades/block/${l.code}`} />
              </li>
            ))}
          </ul>
          {load.next ? (
            <button type="button" style={{ ...btn, alignSelf: "center" }} onClick={loadMore} disabled={load.more}>
              {load.more ? "Loading…" : "Load more"}
            </button>
          ) : null}
          {moreError ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: 0 }}>Couldn&apos;t load more: {moreError}</p> : null}
        </>
      )}
    </main>
  )
}
