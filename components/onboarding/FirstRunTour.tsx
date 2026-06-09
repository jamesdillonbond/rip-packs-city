"use client"
// components/onboarding/FirstRunTour.tsx
//
// First-run product tour. Activates only on the first authenticated
// session — driven by profile_bio.first_run_completed_at being NULL.
// Five steps: welcome (centered modal), then four anchored coach-marks
// pointing at: collection switcher chip, saved-wallets card, chatbot
// launcher, sniper nav link. Final step dismisses and POSTs the
// completion stamp.
//
// Dismissal:
//   - "Skip" button on step 1 → POST first_run_completed_at
//   - "Got it, let me explore" on step 5 → same
//   - Esc key on any step → same
//
// Anchor lookup uses data-tour-anchor selectors so consumer pages don't
// need to import this component to participate. If an anchor isn't
// present on the current page (e.g. saved-wallets card not yet rendered),
// the step falls back to a centered modal with the same body copy.
//
// Brand system: rpc-tokens.css var(--rpc-red), Barlow Condensed display,
// Share Tech Mono body. Backdrop is the same heavy 85%-opacity +
// backdrop-blur-md pattern used by PaywallModal so the layered modal
// state reads consistently across surfaces.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { CSSProperties } from "react"

interface TourStep {
  id: string
  title: string
  body: string
  anchor?: string // data-tour-anchor selector value; undefined = centered
  cta: string
}

const STEPS: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to Rip Packs City",
    body: "You've got access to the smartest analytics platform for Flow blockchain collectibles. Quick tour, then you're in.",
    cta: "Show me around",
  },
  {
    id: "collection-switcher",
    title: "Switch collections any time",
    body: "We cover NBA Top Shot, NFL All Day, LaLiga Golazos, Disney Pinnacle, and UFC Strike. Your wallet auto-loads in any of them where you have moments.",
    anchor: "collection-switcher",
    cta: "Got it",
  },
  {
    id: "saved-wallets",
    title: "Save up to 3 wallets free",
    body: "Add a Top Shot username or Flow address; we'll pre-warm the data so it loads instantly.",
    anchor: "saved-wallets-card",
    cta: "Got it",
  },
  {
    id: "chatbot",
    title: "Ask anything",
    body: "The concierge knows your collection, current FMV, and live deals. Try \"show me the best LeBron deals under $50\".",
    anchor: "chatbot-launcher",
    cta: "Got it",
  },
  {
    id: "sniper",
    title: "Real-time deal flow",
    body: "Sniper surfaces moments listed below FMV across both Top Shot and Flowty. Perfect during pack drops.",
    anchor: "sniper-nav-link",
    cta: "Got it, let me explore",
  },
]

const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 90,
  background: "rgba(0,0,0,0.85)",
  backdropFilter: "blur(12px)",
  WebkitBackdropFilter: "blur(12px)",
}

const POPOVER: CSSProperties = {
  position: "fixed",
  zIndex: 91,
  maxWidth: 380,
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-red-border, rgba(224,58,47,0.4))",
  borderRadius: "var(--radius-lg, 12px)",
  padding: 22,
  boxShadow: "0 20px 60px rgba(0,0,0,0.5)",
  fontFamily: "var(--font-mono)",
  color: "var(--rpc-text-secondary)",
  display: "flex",
  flexDirection: "column",
  gap: 12,
}

const TITLE: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 20,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--rpc-text-primary)",
  margin: 0,
}

const BODY: CSSProperties = {
  fontSize: 13,
  lineHeight: 1.7,
  margin: 0,
}

const STEP_BAR: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-muted)",
}

const FOOTER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 4,
}

const PRIMARY_BTN: CSSProperties = {
  background: "var(--rpc-red, #E03A2F)",
  color: "#fff",
  border: "none",
  padding: "10px 18px",
  borderRadius: "var(--radius-sm, 6px)",
  fontFamily: "var(--font-display)",
  fontWeight: 800,
  fontSize: 12,
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  cursor: "pointer",
}

const SECONDARY_BTN: CSSProperties = {
  background: "transparent",
  color: "var(--rpc-text-muted)",
  border: "none",
  padding: "10px 14px",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  cursor: "pointer",
}

// Distance between anchor and popover in px; matters when the anchor is
// near the viewport edge.
const ANCHOR_GAP = 12

interface PopoverPosition {
  top: number
  left: number
  centered: boolean
}

function computePosition(anchorEl: HTMLElement | null, popoverWidth: number, popoverHeight: number): PopoverPosition {
  if (!anchorEl) {
    return { top: 0, left: 0, centered: true }
  }
  const rect = anchorEl.getBoundingClientRect()
  const viewportW = window.innerWidth
  const viewportH = window.innerHeight

  // Prefer below; fall back above; fall back centered if neither fits.
  const fitsBelow = rect.bottom + ANCHOR_GAP + popoverHeight <= viewportH
  const fitsAbove = rect.top - ANCHOR_GAP - popoverHeight >= 0
  let top: number
  if (fitsBelow) {
    top = rect.bottom + ANCHOR_GAP
  } else if (fitsAbove) {
    top = rect.top - popoverHeight - ANCHOR_GAP
  } else {
    return { top: 0, left: 0, centered: true }
  }
  // Horizontally center on the anchor, then clamp to viewport.
  const idealLeft = rect.left + rect.width / 2 - popoverWidth / 2
  const left = Math.max(16, Math.min(viewportW - popoverWidth - 16, idealLeft))
  return { top, left, centered: false }
}

interface FirstRunTourProps {
  enabled: boolean
  onDismiss: () => void
}

export default function FirstRunTour({ enabled, onDismiss }: FirstRunTourProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [pos, setPos] = useState<PopoverPosition>({ top: 0, left: 0, centered: true })
  const popoverRef = useRef<HTMLDivElement | null>(null)

  const step = STEPS[stepIndex]
  const isLast = stepIndex === STEPS.length - 1
  const isFirst = stepIndex === 0

  const dismiss = useCallback(async () => {
    onDismiss()
    try {
      await fetch("/api/profile/first-run-tour", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ completed: true }),
      })
    } catch { /* fall back to localStorage cache below */ }
    try {
      localStorage.setItem("rpc:first-run-completed", "1")
    } catch { /* private mode */ }
  }, [onDismiss])

  // Position the popover after layout — re-runs on step change + resize.
  useLayoutEffect(() => {
    if (!enabled) return
    function reposition() {
      const anchorEl = step.anchor
        ? document.querySelector<HTMLElement>(`[data-tour-anchor="${step.anchor}"]`)
        : null
      const node = popoverRef.current
      const w = node?.offsetWidth ?? 380
      const h = node?.offsetHeight ?? 200
      setPos(computePosition(anchorEl, w, h))
    }
    reposition()
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    return () => {
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    }
  }, [stepIndex, step.anchor, enabled])

  // Esc to dismiss.
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") dismiss()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [enabled, dismiss])

  if (!enabled) return null

  const popoverStyle: CSSProperties = pos.centered
    ? { ...POPOVER, top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
    : { ...POPOVER, top: pos.top, left: pos.left }

  return (
    <>
      <div style={BACKDROP} aria-hidden onClick={dismiss} />
      <div
        ref={popoverRef}
        style={popoverStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-title"
      >
        <div style={STEP_BAR}>
          Step {stepIndex + 1} of {STEPS.length}
          <span aria-hidden style={{ flex: 1, height: 1, background: "var(--rpc-border)" }} />
        </div>
        <h2 id="first-run-title" style={TITLE}>{step.title}</h2>
        <p style={BODY}>{step.body}</p>
        <div style={FOOTER}>
          {isFirst ? (
            <button onClick={dismiss} style={SECONDARY_BTN}>Skip</button>
          ) : (
            <button onClick={() => setStepIndex(i => Math.max(0, i - 1))} style={SECONDARY_BTN}>
              ← Back
            </button>
          )}
          <button
            onClick={() => {
              if (isLast) dismiss()
              else setStepIndex(i => Math.min(STEPS.length - 1, i + 1))
            }}
            style={PRIMARY_BTN}
          >
            {step.cta}
          </button>
        </div>
      </div>
    </>
  )
}
