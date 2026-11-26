"use client"

// components/collection/CandyCollectionsProgress.tsx
//
// "Every Candy collection you hold" (2026-11-26) — the Candy Sets tab beyond the 2026 MLB Base Series: one
// row per collection the wallet holds a card of, different cards owned of those RPC has catalogued, with
// league / brand chips. The whole list is on the client, so the chips narrow it exactly.
// HONESTY: three states — a failed read says so; a wallet holding nothing says that; otherwise the rows.
// "catalogued" is RPC's count for the collection, a floor on its checklist — the note says it.

import Link from "next/link"
import { useEffect, useMemo, useState, type CSSProperties } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import { scrollRegion } from "@/lib/a11y/scroll-region"
import { progressBrandOptions, toCandyCollectionsProgress, type CandyCollectionsProgress as Progress } from "@/lib/candy/collections-progress"

const cell: CSSProperties = { padding: "6px 8px", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", borderBottom: "1px solid var(--rpc-border-subtle, var(--rpc-border))" }
const head: CSSProperties = { ...cell, fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-text-muted)", textAlign: "left" }
const chip = (on: boolean): CSSProperties => ({
  fontFamily: "var(--font-mono)", fontSize: 11, cursor: "pointer", padding: "6px 10px", borderRadius: 6, minHeight: 32, whiteSpace: "nowrap",
  background: on ? "var(--rpc-red-bg)" : "var(--rpc-surface)", border: `1px solid ${on ? "var(--rpc-red-border)" : "var(--rpc-border)"}`, color: "var(--rpc-text-primary)",
})
const n = (v: number) => v.toLocaleString("en-US")

type State = { status: "loading" } | { status: "failed" } | { status: "ok"; data: Progress }

export default function CandyCollectionsProgress({ wallet, collection }: { wallet: string; collection: string }) {
  const [state, setState] = useState<State>({ status: "loading" })
  const [brand, setBrand] = useState("")
  useEffect(() => {
    let cancelled = false
    fetchJson<unknown>(`/api/candy-collections-progress?wallet=${encodeURIComponent(wallet)}`).then((r) => {
      if (cancelled) return
      const data = r.ok ? toCandyCollectionsProgress(r.json) : null
      setState(data ? { status: "ok", data } : { status: "failed" })
    })
    return () => {
      cancelled = true
    }
  }, [wallet])
  const rows = state.status === "ok" ? state.data.collections : null
  const options = useMemo(() => (rows ? progressBrandOptions(rows) : []), [rows])
  // A pick whose brand is not in THIS wallet's list (a wallet change) falls back to All.
  const active = options.some((o) => o.slug === brand) ? brand : ""
  const shown = useMemo(() => (rows ? (active ? rows.filter((r) => r.brand === active) : rows) : []), [rows, active])

  return (
    <section data-testid="candy-collections-progress" className="rpc-card" style={{ padding: "16px 20px", marginTop: 24 }}>
      <h2 className="rpc-label" style={{ margin: "0 0 4px" }}>Every Candy collection you hold</h2>
      {state.status === "loading" ? (
        <div className="rpc-mono" role="status" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>Loading…</div>
      ) : state.status === "failed" ? (
        <div className="rpc-mono" role="status" data-testid="candy-collections-progress-failed" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
          Couldn&rsquo;t load this list just now. That is a problem on our side &mdash; it does not mean the wallet holds nothing.
        </div>
      ) : state.data.collections.length === 0 ? (
        <div className="rpc-mono" data-testid="candy-collections-progress-empty" style={{ fontSize: 11, color: "var(--rpc-text-muted)" }}>
          RPC has no Candy card on record for this wallet.
        </div>
      ) : (
        <>
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10, lineHeight: 1.6 }}>
            {n(state.data.collections.length)} of the {n(state.data.collections_total)} Candy collections RPC tracks. &ldquo;Catalogued&rdquo; is how many different cards RPC has seen for a collection, so a collection can have more.
          </div>
          {options.length >= 2 ? (
            <div role="group" aria-label="League or brand" data-testid="candy-collections-progress-brands" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <button type="button" aria-pressed={active === ""} onClick={() => setBrand("")} style={chip(active === "")}>All · {n(state.data.collections.length)}</button>
              {options.map((o) => (
                <button key={o.slug} type="button" aria-pressed={active === o.slug} onClick={() => setBrand(o.slug)} style={chip(active === o.slug)}>
                  {o.name} · {n(o.collections)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="rpc-scroll-x" {...scrollRegion("Candy collections you hold")}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
              <thead>
                <tr>
                  <th scope="col" style={head}>Collection</th>
                  <th scope="col" style={head}>Brand</th>
                  <th scope="col" style={head}>Different cards</th>
                  <th scope="col" style={head}>Cards held</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={`${r.name}-${i}`}>
                    <td style={{ ...cell, color: "var(--rpc-text-primary)" }}>
                      {r.set_slug ? <Link prefetch={false} href={`/${collection}/set/${encodeURIComponent(r.set_slug)}`} style={{ color: "inherit" }}>{r.name}</Link> : r.name}
                    </td>
                    <td style={cell}>{r.brand_name ?? "—"}</td>
                    <td style={cell}>
                      {n(r.owned_editions)} of {n(r.editions)} catalogued{r.owned_editions >= r.editions ? " · all" : ""}
                    </td>
                    <td style={cell}>{n(r.cards)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
