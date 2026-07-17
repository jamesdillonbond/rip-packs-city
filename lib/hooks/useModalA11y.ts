// lib/hooks/useModalA11y.ts
//
// Shared modal accessibility primitive: while a modal is open it
//   - moves focus into the modal (first focusable, or the container),
//   - closes on Escape,
//   - traps Tab / Shift+Tab within the modal,
//   - restores focus to the previously-focused element on close.
//
// This is the single implementation of the pattern that used to be
// hand-copied into each modal (MomentDetailModal, OnboardingModal). Point
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

import { useEffect, useRef, type RefObject } from "react"

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

  useEffect(() => {
    if (!isOpen) return
    if (typeof document === "undefined") return

    lastFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null

    const focusFirst = () => {
      const root = containerRef.current
      if (!root) return
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
      lastFocusedRef.current?.focus?.()
    }
  }, [isOpen])

  return containerRef
}
