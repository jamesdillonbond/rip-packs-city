"use client"

// app/giveaways/[slug]/PackRevealClient.tsx
//
// The pack reveal (Trevor, 2026-10-03: "Would we ever be able to do an actual
// pack?" → "Do it all"). A claimer's pack starts SEALED; they open it one card
// at a time, lowest value first and the chase card last. Once opened (or
// skipped), this browser remembers it and the page shows the plain pack grid
// passed in as `children`.
//
// Nothing here changes what the claimer gets: the pack was dealt and
// fingerprinted at sealing, and the cards are the ones already assigned to
// them. The reveal is presentation only.

import { useState, type ReactNode } from "react"
import { chaseMomentId, openedKey, revealOrder, topShotMomentImage } from "@/lib/giveaways/reveal"
import { usd } from "@/lib/giveaways/view-format"

export interface RevealCard {
  moment_id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  fmv_usd: number | null
}

const DISPLAY = "var(--font-display)"
const MONO = "var(--font-mono)"

function readOpened(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}

function saveOpened(key: string): void {
  try {
    localStorage.setItem(key, "1")
  } catch {
    // private mode / blocked storage: the reveal simply shows again next visit
  }
}

export default function PackRevealClient({
  slug,
  packNo,
  moments,
  children,
}: {
  slug: string
  packNo: number
  moments: RevealCard[]
  children: ReactNode
}) {
  const key = openedKey(slug, packNo)
  const [opened, setOpened] = useState(() => readOpened(key))
  const [shown, setShown] = useState(0)
  const order = revealOrder(moments)
  const chase = chaseMomentId(moments)

  if (opened || order.length === 0) return <>{children}</>

  const finish = () => {
    saveOpened(key)
    setOpened(true)
  }

  const started = shown > 0
  const allShown = shown >= order.length
  const nextIsLast = shown === order.length - 1

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {!started ? (
        <div
          style={{
            border: "2px solid var(--rpc-red)",
            borderRadius: 12,
            padding: "28px 16px",
            textAlign: "center",
            background: "var(--rpc-surface-raised)",
          }}
        >
          <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>Sealed</div>
          <div style={{ fontFamily: DISPLAY, fontSize: 32, textTransform: "uppercase", margin: "6px 0" }}>Pack #{packNo}</div>
          <div style={{ fontFamily: MONO, fontSize: 13, color: "var(--rpc-text-secondary)" }}>
            {order.length} {order.length === 1 ? "Moment" : "Moments"} inside
          </div>
        </div>
      ) : null}

      {started ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
          {order.slice(0, shown).map((m) => (
            <RevealedCard key={m.moment_id} m={m} isChase={m.moment_id === chase} />
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {allShown ? (
          <button type="button" onClick={finish} style={primary}>
            Done
          </button>
        ) : (
          <button type="button" onClick={() => setShown((n) => n + 1)} style={primary}>
            {!started ? "Open pack" : nextIsLast ? "Reveal the last card" : `Next card (${shown + 1} of ${order.length})`}
          </button>
        )}
        {!allShown ? (
          <button type="button" onClick={finish} style={secondary}>
            Show all
          </button>
        ) : null}
      </div>
    </div>
  )
}

function RevealedCard({ m, isChase }: { m: RevealCard; isChase: boolean }) {
  const art = topShotMomentImage(m.moment_id, 400)
  return (
    <div
      className="rpc-pack-card-in"
      data-testid="revealed-card"
      style={{
        background: "var(--rpc-surface-raised)",
        border: `1px solid ${isChase ? "var(--rpc-red)" : "var(--rpc-border)"}`,
        borderRadius: 10,
        padding: 10,
      }}
    >
      {isChase ? (
        <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--rpc-red)", textTransform: "uppercase", marginBottom: 6 }}>Chase card</div>
      ) : null}
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={art}
          alt={m.player_name ?? "Top Shot Moment"}
          width={400}
          height={400}
          loading="eager"
          style={{ width: "100%", height: "auto", aspectRatio: "1 / 1", objectFit: "cover", borderRadius: 6, background: "var(--rpc-surface)" }}
        />
      ) : null}
      <div style={{ fontFamily: DISPLAY, fontSize: 16, textTransform: "uppercase", marginTop: 8 }}>{m.player_name ?? "Unknown player"}</div>
      <div style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>{m.set_name ?? "—"}</div>
      <div style={{ fontFamily: MONO, fontSize: 12, marginTop: 4, color: "var(--rpc-text-secondary)" }}>
        {(m.tier ?? "").toUpperCase()}
        {m.serial_number != null ? ` · #${m.serial_number}` : ""} · {usd(m.fmv_usd)}
      </div>
    </div>
  )
}

const primary: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 6,
  border: "none",
  background: "var(--rpc-red)",
  color: "var(--rpc-text-primary)",
  fontFamily: DISPLAY,
  fontSize: 16,
  letterSpacing: 0.5,
  cursor: "pointer",
}

const secondary: React.CSSProperties = {
  ...primary,
  background: "transparent",
  border: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-secondary)",
}
