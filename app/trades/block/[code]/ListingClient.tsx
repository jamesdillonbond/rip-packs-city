"use client"

// app/trades/block/[code]/ListingClient.tsx
//
// One Trade Block listing, and — for a signed-in collector who did not post it — the
// proposal panel: pick what you'd give from your proven accounts, which of the listed
// assets you want, an optional note. States are never collapsed: a failed read is a banner
// with Retry; an account RPC has not indexed reads "not indexed yet", never "holds nothing".

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import type { LineView, ListingView } from "@/lib/trade-block/view"
import type { Holding } from "@/lib/trade-block/store"
import { lineView } from "@/lib/trade-block/view"
import { MAX_LINES_PER_SIDE, NOTE_MAX } from "@/lib/trade-block/rules"
import { Line, ListingCard } from "../block-ui"
import { btn, btnPrimary, call, card, DISPLAY, errorOf, label, muted } from "../../trade-ui"

type Load = { kind: "loading" } | { kind: "error"; error: string; status: number } | { kind: "ok"; listing: ListingView; signedIn: boolean }

export default function ListingClient({ code }: { code: string }) {
  const [load, setLoad] = useState<Load>({ kind: "loading" })

  const read = useCallback(async () => {
    const r = await call(`/api/public/trade-block/${encodeURIComponent(code)}`)
    if (!r.ok || !r.body?.listing) return setLoad({ kind: "error", error: r.ok ? "The response had no listing in it." : errorOf(r), status: r.status })
    setLoad({ kind: "ok", listing: r.body.listing as ListingView, signedIn: r.body.signed_in === true })
  }, [code])

  useEffect(() => {
    let live = true
    void call(`/api/public/trade-block/${encodeURIComponent(code)}`).then((r) => {
      if (!live) return
      if (!r.ok || !r.body?.listing) return setLoad({ kind: "error", error: r.ok ? "The response had no listing in it." : errorOf(r), status: r.status })
      setLoad({ kind: "ok", listing: r.body.listing as ListingView, signedIn: r.body.signed_in === true })
    })
    return () => {
      live = false
    }
  }, [code])

  return (
    <main id="content" style={{ maxWidth: 900, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 16 }}>
      <Link href="/trades/block" style={{ ...muted, textDecoration: "none" }}>
        ← Trade Block
      </Link>
      {load.kind === "loading" ? (
        <p style={muted}>Loading the listing…</p>
      ) : load.kind === "error" ? (
        load.status === 404 ? (
          <section style={card}>
            <p style={{ margin: 0 }}>No such listing. It may have been removed. <Link href="/trades/block">Browse the Trade Block.</Link></p>
          </section>
        ) : (
          <section style={{ ...card, borderColor: "var(--rpc-danger-text)" }}>
            <p style={{ margin: "0 0 8px", color: "var(--rpc-danger-text)", fontSize: 13 }}>Couldn&apos;t load this listing: {load.error}</p>
            <button type="button" style={btn} onClick={() => void read()}>
              Retry
            </button>
          </section>
        )
      ) : (
        <>
          <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: 0, fontSize: 24 }}>{load.listing.username}&apos;s listing</h1>
          {load.listing.state !== "open" ? (
            <p style={{ ...muted, margin: 0 }}>This listing is {load.listing.state}. It no longer takes proposals.</p>
          ) : null}
          <ListingCard l={load.listing} />
          {load.listing.state === "open" ? (
            load.listing.is_mine ? (
              <section style={card}>
                <p style={{ margin: 0, fontSize: 14 }}>
                  This is your listing. Proposals on it show up on <Link href="/trades/block/mine">My Trade Block</Link>.
                </p>
              </section>
            ) : load.signedIn ? (
              <ProposePanel listing={load.listing} />
            ) : (
              <section style={card}>
                <p style={{ margin: 0, fontSize: 14 }}>
                  <Link href={`/login?next=${encodeURIComponent(`/trades/block/${code}`)}`}>Sign in</Link> to propose a trade.
                </p>
              </section>
            )
          ) : null}
        </>
      )}
    </main>
  )
}

type Holdings = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; proven: boolean; indexed: boolean; rows: Holding[]; truncated: boolean }

const key = (l: { collection_id: string; moment_id: string | null }) => `${l.collection_id}:${l.moment_id}`

function ProposePanel({ listing }: { listing: ListingView }) {
  const [open, setOpen] = useState(false)
  const [holdings, setHoldings] = useState<Holdings>({ kind: "loading" })
  const [q, setQ] = useState("")
  const [give, setGive] = useState<Map<string, Holding>>(new Map())
  const [get, setGet] = useState<Set<string>>(new Set(listing.offers.length === 1 ? [key(listing.offers[0])] : []))
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const readHoldings = useCallback(async (query: string) => {
    setHoldings({ kind: "loading" })
    const r = await call(`/api/trade-block?holdings=1&q=${encodeURIComponent(query)}`)
    const h = r.body?.holdings as { proven?: boolean; indexed?: boolean; rows?: Holding[]; truncated?: boolean } | undefined
    if (!r.ok || !h || !Array.isArray(h.rows)) return setHoldings({ kind: "error", error: r.ok ? "The response had no holdings in it." : errorOf(r) })
    setHoldings({ kind: "ok", proven: h.proven === true, indexed: h.indexed === true, rows: h.rows, truncated: h.truncated === true })
  }, [])

  const rows: LineView[] = useMemo(() => (holdings.kind === "ok" ? holdings.rows.map((h) => lineView({ ...h, kind: "moment" }, undefined)) : []), [holdings])

  const toggleGive = (h: Holding) => {
    const next = new Map(give)
    const k = key(h)
    if (next.has(k)) next.delete(k)
    else if (next.size < MAX_LINES_PER_SIDE) next.set(k, h)
    else return setErr(`At most ${MAX_LINES_PER_SIDE} assets per side.`)
    setGive(next)
  }
  const toggleGet = (k: string) => {
    const next = new Set(get)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setGet(next)
  }

  const submit = async () => {
    setErr(null)
    setBusy(true)
    const body = {
      action: "propose",
      code: listing.code,
      give: [...give.values()].map((h) => ({ collection_id: h.collection_id, moment_id: h.moment_id })),
      get: listing.offers.filter((o) => get.has(key(o))).map((o) => ({ collection_id: o.collection_id, moment_id: o.moment_id })),
      note: note.trim() || null,
    }
    const r = await call("/api/trade-block", { method: "POST", body: JSON.stringify(body) })
    setBusy(false)
    if (!r.ok) return setErr(errorOf(r))
    setSent(true)
  }

  if (sent) {
    return (
      <section style={card}>
        <p style={{ margin: 0, fontSize: 14 }}>
          Proposal sent. {listing.username} gets an email and can accept or decline it. Track it on <Link href="/trades/block/mine">My Trade Block</Link>.
        </p>
      </section>
    )
  }

  if (!open) {
    return (
      <section style={card}>
        <button
          type="button"
          style={btnPrimary}
          onClick={() => {
            setOpen(true)
            void readHoldings("")
          }}
        >
          Propose a trade
        </button>
        <p style={{ ...muted, fontSize: 12, margin: "6px 0 0" }}>Pick what you&apos;d give from your own proven accounts and which of these you want. No cash.</p>
      </section>
    )
  }

  return (
    <section style={{ ...card, display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 16, margin: 0 }}>Your proposal</h2>

      <div>
        <div style={label}>You get ({get.size})</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          {listing.offers.map((o) => (
            <Line key={key(o)} line={o} selected={get.has(key(o))} onToggle={() => toggleGet(key(o))} />
          ))}
        </div>
      </div>

      <div>
        <div style={label}>You give ({give.size})</div>
        {holdings.kind === "loading" ? (
          <p style={muted}>Loading your assets…</p>
        ) : holdings.kind === "error" ? (
          <p style={{ color: "var(--rpc-danger-text)", fontSize: 13 }}>
            Couldn&apos;t load your assets: {holdings.error}{" "}
            <button type="button" style={btn} onClick={() => void readHoldings(q)}>
              Retry
            </button>
          </p>
        ) : !holdings.proven ? (
          <p style={{ fontSize: 13 }}>
            Prove a Flow Wallet on <Link href="/trades/block/mine">My Trade Block</Link> first — it signs a sign-in (no fee) so RPC knows the assets you offer are yours.
          </p>
        ) : !holdings.indexed ? (
          <p style={{ ...muted, fontSize: 13 }}>RPC hasn&apos;t indexed the accounts you proved yet. That says nothing about what they hold — try again later.</p>
        ) : (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void readHoldings(q)
              }}
              style={{ display: "flex", gap: 8, margin: "4px 0 8px" }}
            >
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by player, character or set"
                aria-label="Filter your assets"
                style={{ flex: 1, minWidth: 0, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--rpc-border)", background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", fontSize: 13 }}
              />
              <button type="submit" style={btn}>
                Filter
              </button>
            </form>
            {rows.length === 0 ? (
              <p style={muted}>Nothing matches that filter.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 420, overflowY: "auto" }}>
                {holdings.rows.map((h, i) => (
                  <Line key={key(h)} line={rows[i]} selected={give.has(key(h))} onToggle={() => toggleGive(h)} />
                ))}
              </div>
            )}
            {holdings.truncated ? <p style={{ ...muted, fontSize: 12 }}>Showing your 500 highest-valued assets — filter to find others.</p> : null}
          </>
        )}
      </div>

      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={label}>Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
          rows={2}
          placeholder="Anything they should know. No links, contact handles or cash."
          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--rpc-border)", background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", fontSize: 13 }}
        />
      </label>

      {err ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: 0 }}>{err}</p> : null}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={btnPrimary} onClick={submit} disabled={busy || give.size === 0 || get.size === 0}>
          {busy ? "Sending…" : "Send proposal"}
        </button>
        <button type="button" style={btn} onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  )
}
