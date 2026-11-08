"use client"

// app/giveaways/[slug]/PackWall.tsx
//
// The packs still on the table (2026-11-08, "Keep going" on the pack work). Shows
// every pack in the drop as a small sealed pack with the RPC logo: the ones still
// unclaimed bright, the claimed ones dimmed. Packs are UNNUMBERED here on purpose —
// which pack numbers are taken is not something this page knows or needs.
//
// After a successful claim, `drawn` is set to the pack number the DATABASE drew
// (claim_giveaway_pack: uniform over the unclaimed packs). The wall then runs a
// short shuffle across the bright packs and lands on one, labelled with that
// number. The animation is presentation only — the draw already happened, and the
// copy says so. Under reduced motion it lands at once.

import { useEffect, useRef, useState } from "react"

const MONO = "var(--font-mono)"
const LOGO = "/rip-packs-city-logo-320.png"

/** Total animation time for the shuffle (ms); 0 under reduced motion. Exported for the test. */
export const DRAW_MS = 1400
const STEP_MS = 90

function reducedMotion(): boolean {
  try {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  } catch {
    return false
  }
}

export default function PackWall({
  total,
  claimed,
  drawn = null,
  onLanded,
}: {
  total: number
  claimed: number
  /** The pack number the database drew for this claimer; starts the shuffle. */
  drawn?: number | null
  /** Called once the shuffle has landed (immediately under reduced motion). */
  onLanded?: () => void
}) {
  const left = Math.max(0, total - claimed)
  const [lit, setLit] = useState<number | null>(null)
  const [landed, setLanded] = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const landedCb = useRef(onLanded)
  landedCb.current = onLanded

  useEffect(() => {
    if (drawn == null || left === 0) return
    const clear = () => {
      for (const t of timers.current) clearTimeout(t)
      timers.current = []
    }
    clear()
    const finalSlot = (drawn - 1) % left
    const finish = () => {
      setLit(finalSlot)
      setLanded(true)
      landedCb.current?.()
    }
    if (reducedMotion()) {
      finish()
      return clear
    }
    const steps = Math.max(1, Math.floor(DRAW_MS / STEP_MS))
    for (let i = 0; i < steps; i++) {
      timers.current.push(setTimeout(() => setLit((i * 7 + 3) % left), i * STEP_MS))
    }
    timers.current.push(setTimeout(finish, DRAW_MS))
    return clear
  }, [drawn, left])

  if (total < 1) return null
  // Very large drops would make a wall of dots; cap what we draw and say how many.
  const shown = Math.min(total, 60)
  const shownLeft = Math.min(left, shown)

  return (
    <div data-testid="pack-wall">
      <div className="rpc-gw-wall" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => {
          const open = i < shownLeft
          const isLit = open && lit === i
          return (
            <span
              key={i}
              className={`rpc-gw-wall-pack${open ? "" : " is-claimed"}${isLit ? " is-lit" : ""}${isLit && landed ? " is-landed" : ""}`}
              data-state={open ? (isLit ? (landed ? "landed" : "lit") : "open") : "claimed"}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={LOGO} alt="" width={64} height={64} />
            </span>
          )
        })}
      </div>
      <p aria-live="polite" style={{ fontFamily: MONO, fontSize: 12, color: "var(--rpc-text-muted)", margin: "6px 0 0" }}>
        {drawn != null && landed
          ? `Pack #${drawn} is yours — drawn at random from the ${left} that were left.`
          : drawn != null
            ? "Drawing your pack…"
            : `${left} of ${total} ${total === 1 ? "pack" : "packs"} left${total > shown ? ` (showing ${shown})` : ""}`}
      </p>
    </div>
  )
}
