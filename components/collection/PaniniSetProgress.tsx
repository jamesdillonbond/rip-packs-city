"use client"

// PaniniSetProgress — the Panini Sets tab body (/panini-blockchain/sets,
// 2026-09-27). Reads /api/panini-set-progress: since 2026-10-10 every Panini product
// RPC walks, one product at a time (a picker grouped by sport, ?product=<setId>), with an
// optional Panini USERNAME (Panini has no wallets). With a username the picker says how
// many editions RPC has seen them hold in each product.
//
// Honesty rules this component keeps (see the route header for the why):
//   · every count is editions RPC has SEEN — the listing-gated coverage note
//     renders unconditionally, and the column header says "seen"
//   · cost to finish is at today's CONFIRMED lowest asks; missing editions with
//     no such ask are counted beside it ("+ N unpriced"), never priced at $0, and
//     the largest single ask is named because the total is concentrated
//   · "owned" is "seen under this username on RPC's last read", and the tab says
//     so with the date; a username RPC has never seen reads "no cards seen", not
//     "0 of 499"
//   · a failed read is "couldn't load", never an empty table

import { useCallback, useEffect, useRef, useState } from "react"
import PaniniCoverageNote from "@/components/collection/PaniniCoverageNote"
import type { PaniniCoverage } from "@/lib/panini/coverage"
import { paniniProductLabel, type PaniniProductRow, type PaniniSetRow } from "@/lib/panini/set-progress"

export interface PaniniSetProgressResponse {
  username: string | null
  userSeen: boolean | null
  userLastSeenAt: string | null
  /** Every product RPC has catalogued; absent on a pre-2026-10-10 response. */
  products?: PaniniProductRow[]
  /** The product these sets belong to; null when RPC has catalogued none. */
  product?: PaniniProductRow | null
  sets: PaniniSetRow[]
  coverage: PaniniCoverage | null
  coverage_error: boolean
}

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

function capLabel(min: number | null, max: number | null): string {
  if (min === null || max === null) return "—"
  return min === max ? `/${min}` : `/${min}–/${max}`
}

function Note({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: mono, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)" }}>{children}</div>
}

const th: React.CSSProperties = { textAlign: "left", padding: "6px 8px", fontFamily: mono, fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--rpc-text-muted)", borderBottom: "1px solid var(--rpc-border)", whiteSpace: "nowrap" }
const td: React.CSSProperties = { padding: "6px 8px", fontFamily: mono, fontSize: 12, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle)", verticalAlign: "top" }

type LoadState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ok"; data: PaniniSetProgressResponse }

function initialUsername(): string {
  if (typeof window === "undefined") return ""
  const p = new URLSearchParams(window.location.search)
  return (p.get("username") || "").trim()
}

function initialProduct(): string {
  if (typeof window === "undefined") return ""
  const v = (new URLSearchParams(window.location.search).get("product") || "").trim()
  return /^[0-9]{1,6}$/.test(v) ? v : ""
}

function syncUrl(key: string, value: string) {
  try {
    const u = new URL(window.location.href)
    if (value) u.searchParams.set(key, value)
    else u.searchParams.delete(key)
    window.history.replaceState(null, "", u.toString())
  } catch {
    // URL sync is a convenience; the read does not depend on it.
  }
}

export default function PaniniSetProgress() {
  // The input is uncontrolled: ?username= is read on mount and written into the
  // field directly, so no state is set synchronously inside an effect.
  const inputRef = useRef<HTMLInputElement>(null)
  // null = not submitted yet → the URL's ?username= (read inside the effect).
  const [username, setUsername] = useState<string | null>(null)
  // null = not chosen yet → the URL's ?product= (read inside the effect), else the route's default.
  const [product, setProduct] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>({ kind: "loading" })

  useEffect(() => {
    let u = username
    if (u === null) {
      u = initialUsername()
      if (inputRef.current) inputRef.current.value = u
    }
    const prod = product === null ? initialProduct() : product
    let cancelled = false
    const qs = new URLSearchParams()
    if (u) qs.set("username", u)
    if (prod) qs.set("product", prod)
    const url = "/api/panini-set-progress" + (qs.toString() ? "?" + qs.toString() : "")
    const fail = "Set progress is unavailable right now."
    fetch(url)
      .then(async (res) => {
        let body: unknown = undefined
        try {
          body = await res.json()
        } catch {
          body = undefined
        }
        if (cancelled) return
        if (res.status === 400 && (u || prod)) {
          // The username (or product) was malformed — say so; this is not a failed read of the sets.
          const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined
          setState({ kind: "failed", message: typeof e === "string" ? e : fail })
          return
        }
        // Discriminate on status + shape, never on emptiness: a failed read is not an empty tracker.
        if (!res.ok || !body || typeof body !== "object" || !Array.isArray((body as PaniniSetProgressResponse).sets)) {
          setState({ kind: "failed", message: fail })
          return
        }
        setState({ kind: "ok", data: body as PaniniSetProgressResponse })
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed", message: fail })
      })
    return () => {
      cancelled = true
    }
  }, [username, product])

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const next = (inputRef.current?.value ?? "").trim().replace(/^@/, "")
      setState({ kind: "loading" })
      setUsername(next)
      // A new collector gets their own default product (the one RPC has seen them hold most of).
      setProduct("")
      syncUrl("username", next)
      syncUrl("product", "")
    },
    [],
  )

  const pickProduct = useCallback((next: string) => {
    setState({ kind: "loading" })
    setProduct(next)
    syncUrl("product", next)
  }, [])

  return (
    <div>
      <h1 style={{ fontFamily: display, fontWeight: 900, fontSize: 24, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)", margin: "0 0 6px" }}>
        Panini — Set Tracker
      </h1>
      <Note>
        Every set RPC has seen in each Panini product it walks — soccer, NBA, NFL, WNBA, MLB and NASCAR — with the cost to finish it at today&apos;s lowest
        confirmed asks. Pick a product, and enter a Panini username to see which editions RPC has seen that collector holding.
      </Note>

      <form onSubmit={submit} style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0" }}>
        <label htmlFor="panini-username" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Panini username
        </label>
        <input
          id="panini-username"
          ref={inputRef}
          defaultValue=""
          placeholder="Panini username (optional)"
          autoComplete="off"
          spellCheck={false}
          maxLength={32}
          style={{ flex: "1 1 220px", minWidth: 0, padding: "8px 10px", fontFamily: mono, fontSize: 13, background: "var(--rpc-surface)", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 6 }}
        />
        <button
          type="submit"
          style={{ padding: "8px 16px", fontFamily: display, fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", background: "var(--rpc-red)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}
        >
          Track
        </button>
      </form>

      {state.kind === "loading" ? (
        <div aria-busy="true" className="rpc-skeleton" style={{ height: 160, borderRadius: 8 }} />
      ) : state.kind === "failed" ? (
        <div role="alert" style={{ padding: "16px 20px", background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)", borderRadius: 8 }}>
          <div style={{ fontFamily: display, fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>Couldn&apos;t load sets</div>
          <Note>{state.message}</Note>
        </div>
      ) : (
        <SetsBody data={state.data} onPickProduct={pickProduct} />
      )}
    </div>
  )
}

function ProductPicker({ data, onPick }: { data: PaniniSetProgressResponse; onPick: (setId: string) => void }) {
  const products = data.products ?? []
  if (products.length === 0) return null
  const showHeld = data.username !== null && data.userSeen === true
  const groups = new Map<string, PaniniProductRow[]>()
  for (const p of products) {
    const k = p.sport ?? "Other"
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(p)
  }
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "12px 0" }}>
      <label htmlFor="panini-product" style={{ fontFamily: mono, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Product
      </label>
      <select
        id="panini-product"
        value={data.product ? String(data.product.setId) : ""}
        onChange={(e) => onPick(e.target.value)}
        style={{ flex: "1 1 260px", minWidth: 0, maxWidth: "100%", padding: "8px 10px", fontFamily: mono, fontSize: 13, background: "var(--rpc-surface)", color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 6 }}
      >
        {[...groups.entries()].map(([sport, rows]) => (
          <optgroup key={sport} label={sport}>
            {rows.map((p) => (
              <option key={p.setId} value={String(p.setId)}>
                {paniniProductLabel(p)} · {count(p.sets)} sets{showHeld && p.owned > 0 ? ` · ${count(p.owned)} seen held` : ""}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  )
}

function SetsBody({ data, onPickProduct }: { data: PaniniSetProgressResponse; onPickProduct: (setId: string) => void }) {
  const tracking = data.username !== null
  return (
    <>
      <PaniniCoverageNote coverage={data.coverage} failed={data.coverage_error} />
      <ProductPicker data={data} onPick={onPickProduct} />

      {tracking ? (
        <div data-testid="panini-user-status" style={{ margin: "12px 0" }}>
          {data.userSeen ? (
            <Note>
              Showing editions RPC has seen <b>{data.username}</b> holding — last seen {ptDate(data.userLastSeenAt)}
              {data.product && data.product.owned === 0 ? <> (none in this product — pick another above)</> : null}. RPC reads a card&apos;s holder
              when it checks that card, so a card sold since can still show here, and a card that has never been listed is never seen.
            </Note>
          ) : (
            <Note>
              RPC has not seen any card held by <b>{data.username}</b>. RPC sees a card only once it has been listed, so this does not mean the
              collector holds none. Costs below are for the whole set.
            </Note>
          )}
        </div>
      ) : null}

      {data.sets.length === 0 ? (
        <div style={{ marginTop: 12 }}>
          <Note>RPC has not indexed any Panini sets yet.</Note>
        </div>
      ) : (
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 560 }}>
            <thead>
              <tr>
                <th style={th}>Set</th>
                <th style={th}>Editions seen</th>
                <th style={th}>Serials</th>
                {tracking && data.userSeen ? <th style={th}>Seen held</th> : null}
                <th style={th}>Cost to finish</th>
                <th style={th}>Largest ask</th>
              </tr>
            </thead>
            <tbody>
              {data.sets.map((s) => (
                <tr key={`${data.product?.setId ?? ""}:${s.setName}`}>
                  <td style={{ ...td, color: "var(--rpc-text-primary)" }}>{s.setName}</td>
                  <td style={td}>{count(s.editionsSeen)}</td>
                  <td style={td}>{capLabel(s.minMintCap, s.maxMintCap)}</td>
                  {tracking && data.userSeen ? (
                    <td style={td}>
                      {count(s.owned)} of {count(s.editionsSeen)}
                      {s.missing === 0 ? " ✓" : ""}
                    </td>
                  ) : null}
                  <td style={td}>
                    {s.missing === 0 ? (
                      "—"
                    ) : s.missingAsked === 0 ? (
                      <>no confirmed asks</>
                    ) : (
                      <>
                        {usd(s.costUsd)}
                        <span style={{ color: "var(--rpc-text-muted)" }}>
                          {" "}
                          for {count(s.missingAsked)}
                          {s.missingUnasked > 0 ? ` + ${count(s.missingUnasked)} unpriced` : ""}
                        </span>
                      </>
                    )}
                  </td>
                  <td style={td}>{s.missing === 0 || s.missingAsked === 0 ? "—" : usd(s.maxMissingAskUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <Note>
          Cost to finish adds up the lowest ask on each missing edition, counting only asks RPC re-read in the last 7 days. Editions with no such ask
          are shown as unpriced and are not in the total, so the real cost is at least this. &ldquo;Largest ask&rdquo; is the single most expensive
          missing edition — one chase card can be most of a set&apos;s total.
        </Note>
      </div>
    </>
  )
}
