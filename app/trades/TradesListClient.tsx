"use client"

// app/trades/TradesListClient.tsx
//
// The signed-in user's trade rooms, and the two ways in: start one (you become
// side A and share the link) or open a link someone sent you. Four states, never
// collapsed: loading · could not load · none yet · the list. A failed read is a
// banner with Retry, never "no trades yet".

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import type { RoomListEntry } from "@/lib/trade-room/store"
import { call, card, btn, btnPrimary, DISPLAY, errorOf, MONO, muted, stateLabel } from "./trade-ui"

type Load = { kind: "loading" } | { kind: "error"; error: string } | { kind: "ok"; rooms: RoomListEntry[] }

async function fetchRooms(): Promise<Load> {
  const r = await call("/api/trade-room")
  if (!r.ok || !Array.isArray(r.body?.rooms)) return { kind: "error", error: r.ok ? "The response had no trades in it." : errorOf(r) }
  return { kind: "ok", rooms: r.body.rooms as RoomListEntry[] }
}

export default function TradesListClient() {
  const router = useRouter()
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [code, setCode] = useState("")

  const read = useCallback(() => {
    setLoad({ kind: "loading" })
    void fetchRooms().then(setLoad)
  }, [])

  useEffect(() => {
    let live = true
    void fetchRooms().then((l) => {
      if (live) setLoad(l)
    })
    return () => {
      live = false
    }
  }, [])

  const start = async () => {
    setStarting(true)
    setStartError(null)
    const r = await call("/api/trade-room", { method: "POST", body: "{}" })
    setStarting(false)
    const created = (r.body?.room as { code?: unknown } | undefined)?.code
    if (!r.ok || typeof created !== "string") return setStartError(r.ok ? "The trade was created but its link was missing. Reload this page." : errorOf(r))
    router.push(`/trades/${created}`)
  }

  const open = (e: React.FormEvent) => {
    e.preventDefault()
    const m = code.trim().match(/([a-z0-9]{10})\s*$/i)
    if (!m) return setStartError("Paste a trade link or its 10-character code.")
    router.push(`/trades/${m[1].toLowerCase()}`)
  }

  return (
    <main id="content" style={{ maxWidth: 820, margin: "0 auto", padding: "24px 16px 80px", display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <h1 style={{ fontFamily: DISPLAY, textTransform: "uppercase", margin: "0 0 4px", fontSize: 28 }}>Trades</h1>
        <p style={{ ...muted, margin: 0, fontSize: 14 }}>
          Swap NBA Top Shot, NFL All Day, LaLiga Golazos and UFC Strike Moments with another collector — in any mix. Both Flow Wallets sign one transaction, so either every Moment moves or nothing does. RPC never holds a Moment or a key, and charges no fee.
        </p>
        <p style={{ margin: "6px 0 0", fontSize: 14 }}>
          Looking for someone to trade with? <Link href="/trades/block">Browse the Trade Block</Link> or <Link href="/trades/block/mine">post what you&apos;d trade</Link>.
        </p>
      </div>

      <section style={{ ...card, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" style={btnPrimary} onClick={start} disabled={starting}>
          {starting ? "Starting…" : "Start a trade"}
        </button>
        <form onSubmit={open} style={{ display: "flex", gap: 8, flex: 1, minWidth: 240 }}>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Paste a trade link or code"
            aria-label="Trade link or code"
            style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid var(--rpc-border)", background: "var(--rpc-bg)", color: "var(--rpc-text-primary)", fontFamily: MONO, fontSize: 13 }}
          />
          <button type="submit" style={btn}>
            Open
          </button>
        </form>
        {startError ? <p style={{ color: "var(--rpc-danger-text)", fontSize: 13, margin: 0, width: "100%" }}>{startError}</p> : null}
      </section>

      {load.kind === "loading" ? (
        <p style={muted}>Loading your trades…</p>
      ) : load.kind === "error" ? (
        <section style={{ ...card, borderColor: "var(--rpc-danger-text)" }}>
          <p style={{ margin: "0 0 8px", color: "var(--rpc-danger-text)", fontSize: 13 }}>Couldn&apos;t load your trades: {load.error}</p>
          <button type="button" style={btn} onClick={read}>
            Retry
          </button>
        </section>
      ) : load.rooms.length === 0 ? (
        <section style={card}>
          <p style={{ ...muted, margin: 0 }}>No trades yet. Start one and send the link to the collector you want to trade with.</p>
        </section>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {load.rooms.map((r) => (
            <li key={r.code}>
              <Link href={`/trades/${r.code}`} style={{ ...card, display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", textDecoration: "none", color: "inherit" }}>
                <div>
                  <div style={{ fontFamily: DISPLAY, textTransform: "uppercase", fontSize: 15 }}>
                    {stateLabel(r.status)} · you give {r.gives}, get {r.gets}
                  </div>
                  <div style={{ ...muted, fontFamily: MONO, fontSize: 12 }}>
                    {r.code} · {r.counterparty_present ? "two sides" : r.status === "cancelled" || r.status === "expired" ? "nobody joined" : "waiting for the other side"} · updated {new Date(r.updated_at).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })} PT
                  </div>
                </div>
                <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)" }}>Open →</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
