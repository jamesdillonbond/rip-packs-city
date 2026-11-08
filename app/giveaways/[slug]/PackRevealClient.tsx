"use client"

// app/giveaways/[slug]/PackRevealClient.tsx
//
// The pack reveal (Trevor, 2026-10-03: "Would we ever be able to do an actual
// pack?" → "Do it all"; visuals rebuilt 2026-11-08: "We need to improve the
// pack opening visuals"). A claimer's pack starts SEALED as a foil pack; they
// tear it open, then flip the cards one at a time from a face-down stack,
// lowest value first. The chase card (when there is one) charges up before it
// flips. A summary of the whole pack follows. Once finished (or skipped with
// "Show all"), this browser remembers it and the page shows the plain pack grid
// passed in as `children`.
//
// Nothing here changes what the claimer gets: the pack was dealt and
// fingerprinted at sealing, and the cards are the ones already assigned to
// them. The reveal is presentation only. Every animation is CSS and is switched
// off under prefers-reduced-motion (app/rpc-tokens.css), and the timers that
// wait for an animation wait 0 ms there.

import { useEffect, useRef, useState, type ReactNode } from "react"
import { chaseMomentId, openedKey, packTotal, revealOrder, tierKey, topShotMomentImage } from "@/lib/giveaways/reveal"
import { usd } from "@/lib/giveaways/view-format"
import { momentSubjectName } from "@/lib/entity-href"

export interface RevealCard {
  moment_id: string
  player_name: string | null
  set_name: string | null
  tier: string | null
  serial_number: number | null
  fmv_usd: number | null
}

const DISPLAY = "var(--font-display)"
/** The RPC logo (public/rip-packs-city-logo.png, downsized to 320 px) on the pack and every card back. */
const LOGO = "/rip-packs-city-logo-320.png"
const MONO = "var(--font-mono)"

/** ms each animation runs; 0 under reduced motion. Exported for the component test. */
export const TEAR_MS = 700
export const CHARGE_MS = 1100

type Phase = "sealed" | "tearing" | "ripping" | "summary"
// sealed → (tap) tearing → (TEAR_MS) ripping: flip cards one by one; after the last
// flip the last card stays centre stage (the chase gets its burst) → "See the whole
// pack" → summary → "Done".

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

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  } catch {
    return false
  }
}

export default function PackRevealClient({ slug, packNo, moments, children }: { slug: string; packNo: number; moments: RevealCard[]; children: ReactNode }) {
  const key = openedKey(slug, packNo)
  const [opened, setOpened] = useState(() => readOpened(key))
  const [phase, setPhase] = useState<Phase>("sealed")
  const [shown, setShown] = useState(0)
  const [charging, setCharging] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const order = revealOrder(moments)
  const chase = chaseMomentId(moments)
  const total = packTotal(moments)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  if (opened || order.length === 0) return <>{children}</>

  const later = (ms: number, fn: () => void) => {
    if (timer.current) clearTimeout(timer.current)
    const wait = reducedMotion() ? 0 : ms
    timer.current = setTimeout(fn, wait)
  }

  const finish = () => {
    if (timer.current) clearTimeout(timer.current)
    saveOpened(key)
    setOpened(true)
  }

  const tear = () => {
    if (phase !== "sealed") return
    setPhase("tearing")
    later(TEAR_MS, () => setPhase("ripping"))
  }

  const next = order[shown]
  const nextIsChase = next != null && next.moment_id === chase
  const flip = () => {
    if (charging || next == null || phase !== "ripping") return
    const reveal = () => {
      setCharging(false)
      setShown((n) => n + 1)
    }
    if (nextIsChase) {
      setCharging(true)
      later(CHARGE_MS, reveal)
    } else {
      reveal()
    }
  }

  const current = shown > 0 ? order[shown - 1] : null
  const allShown = shown >= order.length
  const left = order.length - shown
  const announce = current ? `${momentSubjectName(current.player_name, null, current.set_name)}${current.moment_id === chase ? ", the chase card" : ""}` : ""

  return (
    <div className="rpc-gw-reveal" data-testid="pack-reveal">
      <div aria-live="polite" style={srOnly}>
        {announce}
      </div>

      {phase === "sealed" || phase === "tearing" ? (
        <div className="rpc-gw-stage">
          <button
            type="button"
            onClick={tear}
            className={`rpc-gw-pack${phase === "tearing" ? " rpc-gw-pack--tear" : ""}`}
            aria-label={`Tear open pack #${packNo}`}
            data-testid="sealed-pack"
          >
            <span className="rpc-gw-pack-strip" aria-hidden="true" />
            <span className="rpc-gw-pack-foil" aria-hidden="true" />
            <span className="rpc-gw-pack-body">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={LOGO} alt="Rip Packs City" width={320} height={320} className="rpc-gw-pack-logo" />
              <span
                style={{
                  fontFamily: DISPLAY,
                  fontSize: 40,
                  lineHeight: 1,
                  textTransform: "uppercase",
                  margin: "10px 0 6px",
                }}
              >
                Pack #{packNo}
              </span>
              <span style={{ fontFamily: MONO, fontSize: 13, opacity: 0.9 }}>
                {order.length} {order.length === 1 ? "Moment" : "Moments"} inside
              </span>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 11,
                  marginTop: 18,
                  opacity: 0.75,
                }}
              >
                Tap to tear open
              </span>
            </span>
          </button>
        </div>
      ) : null}

      {phase === "ripping" ? (
        <div className="rpc-gw-stage">
          <div className="rpc-gw-table">
            {current ? <FlipCard key={current.moment_id} m={current} isChase={current.moment_id === chase} faceUp /> : null}
            {!allShown ? (
              <button
                type="button"
                onClick={flip}
                className={`rpc-gw-stack${charging ? " rpc-gw-stack--charge" : ""}`}
                aria-label={nextIsChase ? "Reveal the last card" : `Flip card ${shown + 1} of ${order.length}`}
                data-testid="card-stack"
              >
                {Array.from({ length: Math.min(left, 3) }).map((_, i, all) => (
                  <span
                    key={i}
                    className={`rpc-gw-stack-card${i === all.length - 1 ? " is-top" : ""}`}
                    style={{ transform: `translate(${i * 3}px, ${i * -3}px)` }}
                    aria-hidden="true"
                  >
                    <CardBack />
                  </span>
                ))}
                <span className="rpc-gw-stack-count" aria-hidden="true">
                  {left} left
                </span>
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {phase === "summary" ? (
        <div className="rpc-gw-summary" data-testid="pack-summary">
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 12,
              flexWrap: "wrap",
            }}
          >
            <span
              style={{
                fontFamily: DISPLAY,
                fontSize: 26,
                textTransform: "uppercase",
              }}
            >
              Pack #{packNo}
            </span>
            {total != null ? (
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 14,
                  color: "var(--rpc-text-secondary)",
                }}
              >
                Total FMV {usd(total)}
              </span>
            ) : null}
          </div>
          <div className="rpc-gw-summary-grid">
            {order.map((m, i) => (
              <div key={m.moment_id} className="rpc-gw-summary-item" style={{ animationDelay: `${i * 70}ms` }}>
                <CardFace m={m} isChase={m.moment_id === chase} compact />
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {phase === "ripping" && shown > 0 ? (
        <ol className="rpc-gw-dots" aria-label="Cards revealed">
          {order.map((m, i) => (
            <li key={m.moment_id} className={i < shown ? "is-on" : undefined} data-tier={i < shown ? tierKey(m.tier) : undefined} />
          ))}
        </ol>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
          justifyContent: "center",
        }}
      >
        {phase === "sealed" ? (
          <button type="button" onClick={tear} style={primary}>
            Open pack
          </button>
        ) : null}
        {phase === "ripping" && !allShown ? (
          <button type="button" onClick={flip} style={primary} disabled={charging}>
            {shown === 0 ? "Flip the first card" : nextIsChase || left === 1 ? "Reveal the last card" : `Next card (${shown + 1} of ${order.length})`}
          </button>
        ) : null}
        {phase === "ripping" && allShown ? (
          <button type="button" onClick={() => setPhase("summary")} style={primary}>
            See the whole pack
          </button>
        ) : null}
        {phase === "summary" ? (
          <button type="button" onClick={finish} style={primary}>
            Done
          </button>
        ) : null}
        {phase !== "summary" ? (
          <button type="button" onClick={finish} style={secondary}>
            Show all
          </button>
        ) : null}
      </div>
    </div>
  )
}

function CardBack() {
  return (
    <span className="rpc-gw-back">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={LOGO} alt="" width={320} height={320} className="rpc-gw-back-logo" />
    </span>
  )
}

function FlipCard({ m, isChase, faceUp }: { m: RevealCard; isChase: boolean; faceUp: boolean }) {
  return (
    <div className={`rpc-gw-flip${faceUp ? " is-up" : ""}${isChase ? " is-chase" : ""}`} data-testid="revealed-card" data-tier={tierKey(m.tier)}>
      <div className="rpc-gw-flip-inner">
        <div className="rpc-gw-flip-back" aria-hidden="true">
          <CardBack />
        </div>
        <div className="rpc-gw-flip-front">
          <CardFace m={m} isChase={isChase} />
        </div>
      </div>
      {isChase ? <span className="rpc-gw-burst" aria-hidden="true" /> : null}
    </div>
  )
}

function CardFace({ m, isChase, compact = false }: { m: RevealCard; isChase: boolean; compact?: boolean }) {
  const art = topShotMomentImage(m.moment_id, compact ? 240 : 480)
  const tier = tierKey(m.tier)
  return (
    <div className="rpc-gw-face" data-tier={tier}>
      <div className="rpc-gw-face-ribbon">
        <span>{(m.tier ?? "Moment").toUpperCase()}</span>
        {isChase ? <span>Chase card</span> : null}
      </div>
      {art ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={art}
          alt={m.player_name ?? "Top Shot Moment"}
          width={compact ? 240 : 480}
          height={compact ? 240 : 480}
          loading="eager"
          style={{
            width: "100%",
            height: "auto",
            aspectRatio: "1 / 1",
            objectFit: "cover",
            borderRadius: 6,
            background: "var(--rpc-surface)",
          }}
        />
      ) : null}
      <div
        style={{
          fontFamily: DISPLAY,
          fontSize: compact ? 15 : 20,
          textTransform: "uppercase",
          marginTop: 8,
          lineHeight: 1.1,
        }}
      >
        {momentSubjectName(m.player_name, null, m.set_name)}
      </div>
      <div style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>{m.set_name ?? "—"}</div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: 12,
          marginTop: 4,
          color: "var(--rpc-text-secondary)",
        }}
      >
        {m.serial_number != null ? `#${m.serial_number} · ` : ""}
        {usd(m.fmv_usd)}
      </div>
    </div>
  )
}

const srOnly: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
}

const primary: React.CSSProperties = {
  padding: "10px 16px",
  borderRadius: 6,
  border: "none",
  background: "var(--rpc-red-fill)",
  color: "#fff",
  fontFamily: DISPLAY,
  fontSize: 17,
  letterSpacing: 0.5,
  cursor: "pointer",
}

const secondary: React.CSSProperties = {
  ...primary,
  background: "transparent",
  border: "1px solid var(--rpc-border)",
  color: "var(--rpc-text-secondary)",
}
