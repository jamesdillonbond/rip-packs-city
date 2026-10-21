"use client"

// 2026-10-21 (Trevor): "the filters need to have a typing spot when there's a ton
// of options, like on the teams filter". A native <select> has no place to type on
// a phone (it opens a scroll wheel), so a long single-choice filter renders this
// instead: a button styled like .rpc-filter-select that opens a list with a
// type-to-filter box. Short lists keep the native <select> (see SniperFilterBar).

import { useEffect, useRef, useState } from "react"

/** Above this many options a filter gets a type-to-filter box (market chips use it too). */
export const SEARCHABLE_SELECT_MIN = 8

export default function SearchableSelect({
  label, value, allValue, allLabel, options, onChange, maxWidth,
}: {
  /** Accessible name of the trigger and the search box ("Team", "Franchise"). */
  label: string
  value: string
  /** The value meaning "no filter" (e.g. "all"). */
  allValue: string
  allLabel: string
  options: string[]
  onChange: (next: string) => void
  maxWidth?: number | string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", onDown)
    document.addEventListener("touchstart", onDown)
    return () => {
      document.removeEventListener("mousedown", onDown)
      document.removeEventListener("touchstart", onDown)
    }
  }, [open])

  const close = () => { setOpen(false); setQuery("") }
  const pick = (v: string) => { onChange(v); close() }
  const q = query.trim().toLowerCase()
  const visible = q ? options.filter(o => o.toLowerCase().includes(q)) : options
  const summary = value === allValue ? allLabel : value

  const optionStyle = (active: boolean): React.CSSProperties => ({
    display: "block",
    width: "100%",
    padding: "6px 8px",
    background: active ? "var(--rpc-surface-hover)" : "transparent",
    border: "none",
    borderRadius: 4,
    textAlign: "left",
    color: active ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
    fontWeight: active ? 700 : 400,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: "inherit",
  })

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block", maxWidth }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="rpc-filter-select"
        style={{ width: "100%", maxWidth, textAlign: "left", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {summary}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            zIndex: 50,
            // Opaque token (--rpc-surface-raised is a see-through tint).
            background: "var(--rpc-surface)",
            border: "1px solid var(--rpc-border)",
            borderRadius: "var(--radius-sm)",
            boxShadow: "0 6px 18px rgba(0,0,0,0.6)",
            padding: 6,
            minWidth: 220,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Escape") close()
              else if (e.key === "Enter" && visible.length === 1) pick(visible[0])
            }}
            placeholder={`Type to filter ${label.toLowerCase()}…`}
            aria-label={`Filter ${label} options`}
            className="rpc-filter-input"
            // 16px keeps iOS Safari from zooming the page on focus.
            style={{ width: "100%", boxSizing: "border-box", marginBottom: 4, fontSize: 16 }}
          />
          <div role="listbox" aria-label={label} style={{ maxHeight: 280, overflow: "auto" }}>
            {!q && (
              <button type="button" role="option" aria-selected={value === allValue} onClick={() => pick(allValue)} style={optionStyle(value === allValue)}>
                {allLabel}
              </button>
            )}
            {visible.map(opt => (
              <button key={opt} type="button" role="option" aria-selected={value === opt} onClick={() => pick(opt)} style={optionStyle(value === opt)}>
                {opt}
              </button>
            ))}
            {q && visible.length === 0 && (
              <div style={{ padding: "6px 8px", color: "var(--rpc-text-muted)" }}>No match for “{query.trim()}”</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
