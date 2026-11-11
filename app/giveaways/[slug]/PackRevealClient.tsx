"use client"

// app/giveaways/[slug]/PackRevealClient.tsx
//
// The pack reveal (Trevor, 2026-10-03: "Would we ever be able to do an actual
// pack?" → "Do it all"; visuals rebuilt 2026-11-08: "We need to improve the
// pack opening visuals"). A claimer's pack starts SEALED as a foil pack; they
// tear it open, then flip the cards one at a time from a face-down stack,
// lowest value first. The chase card (when there is one) charges up before it
// flips. A summary of the whole pack follows.
//
// Opening v3 (Trevor, 2026-11-10: "this needs to look visually appealing as a
// process, and the packs themselves need to look cool"): the pack is a crimped
// foil wrapper with a holographic sheen that tilts under the pointer; the tear
// shakes, peels the strip, leaks light and flashes; the stage is a dark arena
// whose glow takes the colour of the card just flipped; rare-and-up cards carry
// a holo sheen and throw sparks, and the chase lands with a flash and a shake.
//
// Later 11-10 ("do both"): a drop picks its pack design (`theme`, see
// lib/giveaways/pack-theme.ts — "classic" is the red pack, unchanged) and may switch
// on sound (`sound`, lib/giveaways/reveal-sound.ts — synthesised, no files; the
// claimer gets a Sound on/off button and the choice is remembered). Both default
// to the opening as it was: classic, silent. Once finished (or skipped with
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
import { packTheme } from "@/lib/giveaways/pack-theme"
import { createRevealSound, readSoundMuted, saveSoundMuted, type RevealSound } from "@/lib/giveaways/reveal-sound"

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
export const TEAR_MS = 1400
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

/** A short double buzz on phones when the chase lands; nothing under reduced motion or where unsupported. */
export function buzz(): void {
  try {
    if (reducedMotion()) return
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate([60, 40, 120])
  } catch {
    // some browsers throw outside a user gesture; a missing buzz is fine
  }
}

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  } catch {
    return false
  }
}

/**
 * `preview` (the admin's "Preview opening", 2026-11-08): the same opening, but it never
 * reads or writes the claimer's "already opened" flag, and finishing calls `onDone`
 * instead of handing over to `children`.
 */
export default function PackRevealClient({
  slug,
  packNo,
  moments,
  children,
  preview = false,
  onDone,
  title,
  theme,
  sound = false,
}: {
  slug: string
  packNo: number
  /** The drop's name, printed on the pack. */
  title?: string
  /** The drop's pack design; anything unknown or absent draws the classic pack. */
  theme?: string | null
  /** Whether this drop's opening has sound at all (the claimer can still mute it). */
  sound?: boolean
  moments: RevealCard[]
  children: ReactNode
  preview?: boolean
  onDone?: () => void
}) {
  const key = openedKey(slug, packNo)
  const [opened, setOpened] = useState(() => (preview ? false : readOpened(key)))
  const [phase, setPhase] = useState<Phase>("sealed")
  const [shown, setShown] = useState(0)
  const [charging, setCharging] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [muted, setMuted] = useState(() => readSoundMuted())
  const audio = useRef<RevealSound | null>(null)
  /** The drop's sounds, or null when this drop has none. Created on first use, inside a tap. */
  const fx = (): RevealSound | null => {
    if (!sound) return null
    if (!audio.current) audio.current = createRevealSound(muted)
    return audio.current
  }
  const toggleSound = () => {
    const next = !muted
    setMuted(next)
    saveSoundMuted(next)
    audio.current?.setMuted(next)
  }
  const order = revealOrder(moments)
  const chase = chaseMomentId(moments)
  const total = packTotal(moments)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      audio.current?.close()
      audio.current = null
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
    if (preview) {
      onDone?.()
      return
    }
    saveOpened(key)
    setOpened(true)
  }

  const tear = () => {
    if (phase !== "sealed") return
    setPhase("tearing")
    fx()?.tear(reducedMotion())
    preloadArt(order)
    later(TEAR_MS, () => setPhase("ripping"))
  }

  const next = order[shown]
  const nextIsChase = next != null && next.moment_id === chase
  const flip = () => {
    if (charging || next == null || phase !== "ripping") return
    const reveal = () => {
      setCharging(false)
      setShown((n) => n + 1)
      if (nextIsChase) {
        buzz()
        fx()?.chase(tierKey(next.tier))
      } else {
        fx()?.flip(tierKey(next.tier))
      }
    }
    if (nextIsChase) {
      if (!reducedMotion()) fx()?.charge(CHARGE_MS)
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
    <div className="rpc-gw-reveal" data-testid="pack-reveal" data-pack-theme={packTheme(theme)}>
      <div aria-live="polite" style={srOnly}>
        {announce}
      </div>

      {phase === "sealed" || phase === "tearing" ? (
        <div className="rpc-gw-stage" data-phase={phase}>
          <span className="rpc-gw-pack-float">
            <button
              type="button"
              onClick={tear}
              onPointerMove={phase === "sealed" ? tiltMove : undefined}
              onPointerLeave={tiltReset}
              className={`rpc-gw-pack${phase === "tearing" ? " rpc-gw-pack--tear" : ""}`}
              aria-label={`Tear open pack #${packNo}`}
              data-testid="sealed-pack"
            >
              <span className="rpc-gw-pack-strip" aria-hidden="true">
                <span>Tear here</span>
              </span>
              <span className="rpc-gw-pack-light" aria-hidden="true" />
              <span className="rpc-gw-pack-wrap">
                <span className="rpc-gw-pack-holo" aria-hidden="true" />
                <span className="rpc-gw-pack-foil" aria-hidden="true" />
                <span className="rpc-gw-pack-body">
                  <span className="rpc-gw-pack-badge">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={LOGO} alt="Rip Packs City" width={320} height={320} className="rpc-gw-pack-logo" />
                  </span>
                  {title ? <span className="rpc-gw-pack-title">{title}</span> : null}
                  <span className="rpc-gw-pack-no" style={{ fontFamily: DISPLAY }}>
                    Pack #{packNo}
                  </span>
                  <span className="rpc-gw-pack-plate" style={{ fontFamily: MONO }}>
                    {order.length} {order.length === 1 ? "Moment" : "Moments"} inside
                  </span>
                  <span className="rpc-gw-pack-hint" style={{ fontFamily: MONO }}>
                    Tap to tear open
                  </span>
                </span>
              </span>
              {phase === "tearing" ? <Sparks n={14} spread={120} /> : null}
            </button>
          </span>
          {phase === "tearing" ? <span className="rpc-gw-flash rpc-gw-flash--tear" aria-hidden="true" /> : null}
        </div>
      ) : null}

      {phase === "ripping" ? (
        <div
          className={`rpc-gw-stage${charging ? " is-charging" : ""}${current && current.moment_id === chase ? " is-slam" : ""}`}
          data-phase="ripping"
          data-tier={current ? tierKey(current.tier) : undefined}
        >
          {current ? <span key={current.moment_id} className="rpc-gw-amb" aria-hidden="true" /> : null}
          {current && current.moment_id === chase ? <span className="rpc-gw-flash" aria-hidden="true" /> : null}
          <div className={`rpc-gw-table${current ? " has-card" : ""}`}>
            {current ? <FlipCard key={current.moment_id} m={current} isChase={current.moment_id === chase} faceUp /> : null}
            {!allShown ? (
              <button
                type="button"
                onClick={flip}
                className={`rpc-gw-stack${charging ? " rpc-gw-stack--charge" : ""}`}
                data-tier={charging && next ? tierKey(next.tier) : undefined}
                aria-label={nextIsChase ? "Reveal the last card" : `Flip card ${shown + 1} of ${order.length}`}
                data-testid="card-stack"
              >
                {Array.from({ length: Math.min(left, 3) }).map((_, i, all) => (
                  <span
                    key={i}
                    className={`rpc-gw-stack-card${i === all.length - 1 ? " is-top" : ""}`}
                    style={{ transform: `translate(${i * 3}px, ${i * -3}px) rotate(${(i - (all.length - 1)) * 2.5}deg)` }}
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
              <div key={m.moment_id} className={`rpc-gw-summary-item${m.moment_id === chase ? " is-chase" : ""}`} style={{ animationDelay: `${i * 90}ms` }}>
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
          <button
            type="button"
            onClick={() => {
              fx()?.summary()
              setPhase("summary")
            }}
            style={primary}
          >
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
        {sound ? (
          <button type="button" onClick={toggleSound} style={secondary} aria-pressed={!muted} data-testid="sound-toggle">
            {muted ? "Sound off" : "Sound on"}
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

/** Warm the browser's image cache while the pack tears, so no card flips to a blank frame. */
function preloadArt(cards: readonly RevealCard[]): void {
  try {
    if (typeof Image === "undefined") return
    for (const c of cards) {
      const src = topShotMomentImage(c.moment_id, 480)
      if (src) new Image().src = src
    }
  } catch {
    // a failed preload only means the art loads at flip time, as before
  }
}

/** Tilt an element toward the pointer and move its glare (CSS reads the four variables). Off under reduced motion. */
function tiltMove(e: React.PointerEvent<HTMLElement>): void {
  if (reducedMotion()) return
  const el = e.currentTarget
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))
  el.style.setProperty("--gw-rx", `${((0.5 - y) * 18).toFixed(1)}deg`)
  el.style.setProperty("--gw-ry", `${((x - 0.5) * 22).toFixed(1)}deg`)
  el.style.setProperty("--gw-mx", `${(x * 100).toFixed(0)}%`)
  el.style.setProperty("--gw-my", `${(y * 100).toFixed(0)}%`)
}

function tiltReset(e: React.PointerEvent<HTMLElement>): void {
  const el = e.currentTarget
  for (const v of ["--gw-rx", "--gw-ry", "--gw-mx", "--gw-my"]) el.style.removeProperty(v)
}

/** Sparks thrown from the centre of their parent: fixed angles (golden-angle spread), so no randomness to hydrate. */
function Sparks({ n, spread }: { n: number; spread: number }) {
  return (
    <span className="rpc-gw-sparks" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const style = {
          "--a": `${Math.round((i * 137.5) % 360)}deg`,
          "--d": `${Math.round(spread * (0.55 + ((i * 53) % 45) / 100))}px`,
          "--s": `${(i % 5) * 45}ms`,
        } as React.CSSProperties
        return <i key={i} style={style} data-alt={i % 3 === 0 ? "1" : undefined} />
      })}
    </span>
  )
}

function FlipCard({ m, isChase, faceUp }: { m: RevealCard; isChase: boolean; faceUp: boolean }) {
  const tier = tierKey(m.tier)
  const big = tier === "legendary" || tier === "ultimate"
  return (
    <div className={`rpc-gw-flip${faceUp ? " is-up" : ""}${isChase ? " is-chase" : ""}`} data-testid="revealed-card" data-tier={tier}>
      <div className="rpc-gw-tilt" onPointerMove={tiltMove} onPointerLeave={tiltReset}>
        <div className="rpc-gw-flip-inner">
          <div className="rpc-gw-flip-back" aria-hidden="true">
            <CardBack />
          </div>
          <div className="rpc-gw-flip-front">
            <CardFace m={m} isChase={isChase} />
          </div>
        </div>
      </div>
      {isChase || big ? <span className="rpc-gw-burst" aria-hidden="true" /> : null}
      {isChase ? <Sparks n={26} spread={230} /> : tier !== "common" ? <Sparks n={big ? 18 : 10} spread={big ? 200 : 160} /> : null}
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
            display: "block", // a failed image keeps its square frame instead of collapsing to alt text
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
