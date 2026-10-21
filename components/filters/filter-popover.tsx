"use client"

// Shared plumbing for the type-to-filter dropdowns (SearchableSelect, MultiSelect):
// dismiss on an outside press, keep the panel inside the viewport on a phone,
// focus the search box when opened with a mouse, and render a highlighted label.

import { Fragment, useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { highlightParts } from "@/lib/filter-match"

/** Above this many options a filter gets a type-to-filter box. */
export const SEARCHABLE_SELECT_MIN = 8

/** Close when a press lands outside `rootRef` (mouse or touch). */
export function useDismissOnOutsidePress(rootRef: RefObject<HTMLElement | null>, open: boolean, onDismiss: () => void) {
  const cb = useRef(onDismiss)
  useEffect(() => { cb.current = onDismiss })
  useEffect(() => {
    if (!open) return
    const onDown = (e: Event) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) cb.current()
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("touchstart", onDown)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("touchstart", onDown)
    }
  }, [open, rootRef])
}

/**
 * Keep an absolutely-positioned panel inside the viewport — a chip near the right
 * edge of a 390px screen otherwise opens a panel past it and the whole page
 * scrolls sideways. Writes `left` on the panel directly (a layout offset, not a
 * transform: Chrome still counts a translated panel's UNtransformed box as page
 * overflow — measured, scrollWidth stayed 534 px on a 390 px phone).
 */
export function useKeepInViewport(panelRef: RefObject<HTMLElement | null>, open: boolean) {
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!open || !el || typeof window === "undefined") return
    el.style.left = "0px"
    const r = el.getBoundingClientRect()
    const gutter = 8
    // ⚠ NOT window.innerWidth: on a phone that is the LAYOUT viewport, which grows
    // to fit overflowing content — measured 534 px on a 390 px screen with this very
    // panel open, so the nudge came out at -8 px. The root's clientWidth stays at
    // the device width.
    const vw = document.documentElement.clientWidth || window.innerWidth
    const over = r.right - (vw - gutter)
    if (over > 0) el.style.left = `${-Math.min(over, Math.max(0, r.left - gutter))}px`
  }, [open, panelRef])
}

/** Enter / Space on an option row that itself holds focus (a click can give a tabIndex=-1 row focus). */
export function onOptionKey(e: React.KeyboardEvent, act: () => void) {
  // stopPropagation: the list itself also handles these keys (MultiSelect without a search box).
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); act() }
}

/**
 * Focus the search box on open — but only with a precise pointer. On a phone,
 * focusing pops the keyboard over half the list before the user asked to type.
 */
export function useFocusOnOpen(inputRef: RefObject<HTMLElement | null>, open: boolean) {
  useEffect(() => {
    if (!open || !inputRef.current) return
    const fine = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches
    if (fine) inputRef.current.focus({ preventScroll: true })
  }, [open, inputRef])
}

/** Scroll the active option into view as the arrow keys move it. */
export function useScrollActiveIntoView(id: string | undefined) {
  useEffect(() => {
    if (!id || typeof document === "undefined") return
    const el = document.getElementById(id) as (HTMLElement & { scrollIntoView?: (o?: ScrollIntoViewOptions) => void }) | null
    el?.scrollIntoView?.({ block: "nearest" })
  }, [id])
}

export function HighlightedLabel({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query)
  if (parts.length === 1 && !parts[0].match) return <>{text}</>
  return (
    <>
      {parts.map((p, i) => p.match
        ? <mark key={i} style={{ background: "transparent", color: "var(--rpc-text-primary)", fontWeight: 700, textDecoration: "underline", textUnderlineOffset: 2 }}>{p.text}</mark>
        // Bare text, not a <span>: an accessible-name walk can trim at element
        // edges and read "Luka Dončić" as "LukaDončić".
        : <Fragment key={i}>{p.text}</Fragment>)}
    </>
  )
}

export const panelStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 4px)",
  left: 0,
  zIndex: 50,
  // ⚠ OPAQUE token. --rpc-surface-raised is a 3% tint, so an open list painted
  // see-through over the controls beneath it (2026-09-29 mobile report).
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-sm)",
  boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
  padding: 6,
  maxWidth: "calc(100vw - 16px)",
  boxSizing: "border-box",
  fontFamily: "var(--font-mono)",
}

export const searchInputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  marginBottom: 4,
  padding: "6px 10px",
  background: "var(--rpc-surface-raised)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-sm)",
  color: "var(--rpc-text-primary)",
  fontFamily: "var(--font-mono)",
  // 16px keeps iOS Safari from zooming the page when the box takes focus.
  fontSize: 16,
  outline: "none",
}

export function optionStyle(active: boolean, selected: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    // 36px rows: a comfortable tap target without making a 30-team list endless.
    minHeight: 36,
    padding: "6px 8px",
    boxSizing: "border-box",
    background: active ? "var(--rpc-surface-hover)" : "transparent",
    borderRadius: 4,
    textAlign: "left",
    color: selected ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
    fontWeight: selected ? 700 : 400,
    cursor: "pointer",
    userSelect: "none",
    // The active-row background is the feedback; the browser's tap flash on top read as a stuck selection.
    WebkitTapHighlightColor: "transparent",
  }
}

export function NoMatch({ query }: { query: string }) {
  return <div role="status" style={{ padding: "6px 8px", color: "var(--rpc-text-muted)" }}>No match for “{query.trim()}”</div>
}
