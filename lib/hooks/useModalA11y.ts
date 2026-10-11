// lib/hooks/useModalA11y.ts
//
// Shared modal accessibility primitive: while a modal is open it
//   - moves focus into the modal (first focusable, or the container),
//   - closes on Escape,
//   - traps Tab / Shift+Tab within the modal,
//   - restores focus to the previously-focused element on close.
//
// This is the single implementation of the pattern that used to be
// hand-copied into each modal (e.g. MomentDetailModal). Point
// every modal at this hook so the behavior can't drift between them and the
// next modal gets it for free.
//
// Usage:
//   const modalRef = useModalA11y<HTMLDivElement>(isOpen, onClose)
//   ...
//   {isOpen && (
//     <div role="dialog" aria-modal="true" onClick={onClose}>
//       <div ref={modalRef} onClick={(e) => e.stopPropagation()}>…</div>
//     </div>
//   )}
//
// Attach the returned ref to the modal's CONTENT container (the element that
// holds the focusable children), not the backdrop.

import { useEffect, useMemo, useRef, type RefObject } from "react"

// Elements considered tabbable for the focus trap + initial-focus target.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])'

export function useModalA11y<T extends HTMLElement = HTMLElement>(
  isOpen: boolean,
  onClose: () => void,
): RefObject<T | null> {
  const containerRef = useRef<T | null>(null)
  const lastFocusedRef = useRef<HTMLElement | null>(null)

  // Hold the latest onClose without making it an effect dependency, so the
  // trap installs exactly once per open (and never re-runs — and re-steals
  // focus — when a parent passes a freshly-identified onClose each render).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Read the OPENER during the render that opens the modal, not in the effect.
  // React applies a child's `autoFocus` at commit, which runs BEFORE this hook's
  // effect — so an effect-time read of document.activeElement saw the modal's
  // own input, the "restore" on close focused a detached node, and keyboard
  // focus fell to <body> (found live on the New Alert modal, 2026-10-10).
  // useMemo keyed on isOpen runs at the open transition and before any commit
  // of the open subtree; it is a read of DOM state, not a write.
  const openerAtOpen = useMemo<HTMLElement | null>(() => {
    if (!isOpen || typeof document === "undefined") return null
    const active = document.activeElement as HTMLElement | null
    return active && active !== document.body ? active : null
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    if (typeof document === "undefined") return

    // Never record something inside the modal as the opener.
    const root = containerRef.current
    const candidate = openerAtOpen ?? ((document.activeElement as HTMLElement | null) ?? null)
    lastFocusedRef.current =
      candidate && candidate !== document.body && !(root && root.contains(candidate)) ? candidate : null

    const focusFirst = () => {
      const root = containerRef.current
      if (!root) return
      // A child that already took focus (`autoFocus`, or the modal's own effect)
      // wins — the first-focusable rule is the fallback, not an override.
      if (document.activeElement && root.contains(document.activeElement)) return
      const focusables = root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ;(focusables[0] ?? root).focus()
    }
    const raf = requestAnimationFrame(focusFirst)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current()
        return
      }
      if (e.key !== "Tab") return
      const root = containerRef.current
      if (!root) return
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute("aria-hidden"))
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && active === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      }
    }

    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      cancelAnimationFrame(raf)
      const opener = lastFocusedRef.current
      lastFocusedRef.current = null
      if (opener && opener.isConnected) opener.focus?.()
    }
  }, [isOpen, openerAtOpen])

  return containerRef
}
