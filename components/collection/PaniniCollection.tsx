"use client"

// PaniniCollection — the Panini Collection tab body (/panini-blockchain/collection,
// 2026-09-27). Reads /api/panini-collection (panini_owner_cards) for a Panini
// USERNAME — Panini has no wallets.
//
// Honesty rules this component keeps (see the route header for the why):
//   · it is "cards RPC has seen under this username", never "your collection":
//     RPC reads a card's holder only when the card has been listed, so most
//     usernames appear only through their own listings — the tab says so
//   · a username with nothing seen reads "RPC hasn't seen a card under …",
//     never "0 cards" / "holds nothing"
//   · the FMV tile says how many of the seen cards it prices; unpriced cards are
//     not $0
//   · a failed read is "couldn't load", never an empty grid

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import MomentMedia from "@/components/MomentMedia"
import type { PaniniOwnerCards } from "@/lib/panini/owner-cards"

const STORAGE_KEY = "rpc.panini.collection.username"
const mono = "var(--font-mono)"
const display = "var(--font-display)"

function usd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return "$" + n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2, minimumFractionDigits: n >= 100 ? 0 : 2 })
}
function count(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—"
  return n.toLocaleString("en-US")
}
/** Absolute PT date — the reader's clock never enters render. */
function ptDate(iso: string | null): string {
  if (!iso) return "—"
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return "—"
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Los_Angeles" })
}
const FLAG_LABEL: Record<string, string> = { "#1": "#1", jersey: "Jersey", last_mint: "Perfect" }

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}
function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)", borderRadius: 8, padding: "12px 14px", minWidth: 130, flex: "1 1 130px" }}>
      <div style={{ fontFamily: mono, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>{label}</div>
      <div style={{ fontFamily: display, fontWeight: 800, fontSize: 22, color: "var(--rpc-text-primary)", marginTop: 4 }}>{value}</div>
      {sub ? <div style={{ fontFamily: mono, fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 2 }}>{sub}</div> : null}
    </div>
  )
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ok"; data: PaniniOwnerCards }

function initialUsername(): string {
  try {
    const fromUrl = (new URLSearchParams(window.location.search).get("username") || "").trim()
    if (fromUrl) return fromUrl
    return (window.localStorage.getItem(STORAGE_KEY) || "").trim()
  } catch {
    return ""
  }
}

export default function PaniniCollection() {
  const inputRef = useRef<HTMLInputElement>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>({ kind: "idle" })

  useEffect(() => {
    let u = username
    if (u === null) {
      u = initialUsername()
      if (inputRef.current) inputRef.current.value = u
    }
    if (!u) return
    let cancelled = false
    const fail = "This collection is unavailable right now."
    fetch("/api/panini-collection?username=" + encodeURIComponent(u))
      .then(async (res) => {
        let body: unknown = undefined
        try {
          body = await res.json()
        } catch {
          body = undefined
        }
        if (cancelled) return
        if (res.status === 400) {
          const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined
          setState({ kind: "failed", message: typeof e === "string" ? e : fail })
          return
        }
        // Discriminate on status + shape: a failed read is not an empty collection.
        if (!res.ok || !body || typeof body !== "object" || typeof (body as PaniniOwnerCards).cardsSeen !== "number") {
          setState({ kind: "failed", message: fail })
          return
        }
        setState({ kind: "ok", data: body as PaniniOwnerCards })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed", message: fail })
      })
    return () => {
      cancelled = true
    }
  }, [username])

  const submit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    const next = (inputRef.current?.value ?? "").trim().replace(/^@/, "")
    if (!next) return
    setState({ kind: "loading" })
    setUsername(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
      const url = new URL(window.location.href)
      url.searchParams.set("username", next)
      window.history.replaceState(null, "", url.toString())
    } catch {
      // Remembering the username is a convenience; the read does not depend on it.
    }
  }, [])

  return (
    <div>
      <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 6px" }}>
        Panini — Collection
      </h1>
      <Note>
        Enter a Panini username to see the cards RPC has seen under it. Panini has no public wallet view, so RPC learns who holds a card only
        when that card is listed for sale — for most collectors this shows their listings, not everything they own.
      </Note>

      <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <label htmlFor="panini-collection-username" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Panini username
        </label>
        <input
          id="panini-collection-username"
          ref={inputRef}
          defaultValue=""
          placeholder="Panini username"
          autoComplete="off"
          spellCheck={false}
          maxLength={32}
          style={{ flex: "1 1 220px", minWidth: 0, padding: "8px 10px", fontFamily: mono, fontSize: 13, background: "var(--rpc-surface)", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 6 }}
        />
        <button
          type="submit"
          style={{ padding: "8px 16px", fontFamily: display, fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", background: "var(--rpc-red)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}
        >
          Look up
        </button>
      </form>

      {state.kind === "idle" ? null : state.kind === "loading" ? (
        <div aria-busy="true" className="rpc-skeleton" style={{ height: 120, borderRadius: 8 }} />
      ) : state.kind === "failed" ? (
        <div role="alert" style={{ padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
          <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load this collection</div>
          <Note>{state.message}</Note>
        </div>
      ) : (
        <CollectionBody data={state.data} />
      )}
    </div>
  )
}

function CollectionBody({ data }: { data: PaniniOwnerCards }) {
  if (data.cardsSeen === 0) {
    return (
      <div data-testid="panini-collection-unseen" style={{ padding: "14px 16px", border: "1px dashed var(--rpc-border)", borderRadius: 8 }}>
        <Note>
          RPC hasn&apos;t seen a card under <b>{data.username}</b>. RPC only learns a card&apos;s holder when the card is listed for sale on
          Panini&apos;s marketplace, so this does not mean the collector holds nothing — it means none of their cards has been listed while RPC
          was looking.
        </Note>
      </div>
    )
  }
  const unlisted = data.cardsSeen - data.listedNow
  const shown = data.cards.length
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Tile label="Cards seen" value={count(data.cardsSeen)} sub={`${count(data.editions)} editions`} />
        <Tile label="Listed now" value={count(data.listedNow)} sub={unlisted > 0 ? `${count(unlisted)} seen unlisted` : undefined} />
        <Tile
          label="FMV of cards seen"
          value={usd(data.fmvSeenUsd)}
          sub={`${count(data.fmvPricedCards)} of ${count(data.cardsSeen)} priced`}
        />
        <Tile label="Special serials" value={count(data.specialSerials)} />
      </div>
      <div style={{ marginTop: 8 }}>
        <Note>
          Last seen {ptDate(data.lastSeenAt)}. A card sold since RPC last read it can still appear here.
          {shown < data.cardsSeen ? ` Showing the ${count(shown)} highest-FMV cards of ${count(data.cardsSeen)}.` : ""}
        </Note>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginTop: 14 }}>
        {data.cards.map((c) => {
          const inner = (
            <>
              <div style={{ aspectRatio: "1 / 1", borderRadius: 6, overflow: "hidden", background: "var(--rpc-surface)" }}>
                {c.thumbnailUrl ? <MomentMedia thumbnailUrl={c.thumbnailUrl} alt={`${c.playerName ?? "Card"} — ${c.setName ?? ""}`} size={160} rounded={6} /> : null}
              </div>
              <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", marginTop: 6, lineHeight: 1.2 }}>{c.playerName ?? "—"}</div>
              <div style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>{c.setName ?? "—"}</div>
              <div style={{ fontFamily: mono, fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 4 }}>
                {c.serial != null ? `#${c.serial}${c.mintCap != null ? `/${c.mintCap}` : ""}` : "serial —"}
                {c.flags.length ? ` · ${c.flags.map((f) => FLAG_LABEL[f] ?? f).join(", ")}` : ""}
              </div>
              <div style={{ fontFamily: mono, fontSize: 11, color: "var(--rpc-text-secondary)", marginTop: 2 }}>
                FMV {usd(c.fmvUsd)}
                {c.isListed && c.askUsd != null ? <> · listed {usd(c.askUsd)}</> : null}
              </div>
            </>
          )
          return c.editionKey ? (
            <Link key={c.sku} href={`/panini-blockchain/edition/${encodeURIComponent(c.editionKey)}`} className="rpc-card" style={{ padding: 8, textDecoration: "none", color: "inherit", display: "block" }}>
              {inner}
            </Link>
          ) : (
            <div key={c.sku} className="rpc-card" style={{ padding: 8 }}>{inner}</div>
          )
        })}
      </div>
    </>
  )
}
