"use client"

// Multi-choice filter chip (market Set / Series / Team / Badges). Extracted from
// MarketClient 2026-10-21. Long lists (> SEARCHABLE_SELECT_MIN) get a
// type-to-filter box; short ones open straight to the list.
//
// Pattern: WAI-ARIA multi-select listbox (aria-multiselectable). Keys: ↓/↑ move,
// Enter or Space toggles (Space only when the box is empty, so a query can hold
// spaces), Escape closes and returns focus to the chip, Tab closes. Options the
// user had already picked are pinned to the top WHEN THE LIST OPENS — re-sorting
// on every toggle would move a row out from under the pointer.

import { useId, useMemo, useRef, useState } from "react"
import { filterOptions } from "@/lib/filter-match"
import {
  HighlightedLabel, NoMatch, SEARCHABLE_SELECT_MIN, optionStyle, panelStyle, searchInputStyle,
  onOptionKey, useDismissOnOutsidePress, useFocusOnOpen, useKeepInViewport, useScrollActiveIntoView,
} from "@/components/filters/filter-popover"

export default function MultiSelect({
  label, selected, options, onChange, formatOption,
}: {
  label: string
  selected: string[]
  options: string[]
  onChange: (next: string[]) => void
  /** Display label for an option value (the VALUE still round-trips to the API). */
  formatOption?: (v: string) => string
}) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  // Order fixed at open time: picked first, then the rest in the list's own order.
  const [pinned, setPinned] = useState<string[]>([])
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const fmt = useMemo(() => formatOption ?? ((v: string) => v), [formatOption])
  const searchable = options.length > SEARCHABLE_SELECT_MIN
  const ordered = useMemo(() => {
    const keep = pinned.filter(v => options.includes(v))
    return [...keep, ...options.filter(v => !keep.includes(v))]
  }, [pinned, options])
  const visible = useMemo(
    () => (searchable ? filterOptions(ordered, query, fmt) : ordered),
    [searchable, ordered, query, fmt],
  )

  const summary = selected.length === 0 ? "Any" : selected.length === 1 ? fmt(selected[0]) : `${selected.length} selected`
  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter(x => x !== v))
    else onChange([...selected, v])
  }
  const openList = () => {
    setPinned(selected)
    setQuery("")
    setActive(0)
    setOpen(true)
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    setQuery("")
    if (refocus) triggerRef.current?.focus()
  }

  useDismissOnOutsidePress(rootRef, open, () => close(false))
  useFocusOnOpen(searchable ? inputRef : listRef, open)
  useKeepInViewport(panelRef, open)
  const activeId = open && visible[active] !== undefined ? `${id}-opt-${active}` : undefined
  useScrollActiveIntoView(activeId)

  const onKey = (e: React.KeyboardEvent) => {
    const typingSpace = e.key === " " && query !== ""
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(visible.length - 1, a + 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if ((e.key === "Enter" || (e.key === " " && !typingSpace)) && visible[active] !== undefined) { e.preventDefault(); toggle(visible[active]) }
    else if (e.key === "Escape") { e.preventDefault(); close(true) }
    else if (e.key === "Tab") close(false)
  }

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span id={`${id}-label`} className="rpc-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={e => { if (!open && e.key === "ArrowDown") { e.preventDefault(); openList() } }}
        className="rpc-chip"
        style={{
          minWidth: 110,
          background: selected.length > 0 ? "var(--rpc-surface-hover)" : "transparent",
          color: selected.length > 0 ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
          fontWeight: selected.length > 0 ? 700 : 500,
        }}
        id={`${id}-trigger`}
        aria-labelledby={`${id}-label ${id}-trigger`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={options.length === 0}
        title={options.length === 0 ? "No options in current results" : undefined}
      >
        {summary} ▾
      </button>
      {open && options.length > 0 && (
        <div
          ref={panelRef}
          style={{ ...panelStyle, minWidth: searchable ? 240 : 180, fontSize: 11 }}
        >
          {searchable && (
            <input
              ref={inputRef}
              type="text"
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeId}
              aria-label={`Filter ${label} options`}
              value={query}
              onChange={e => { setQuery(e.target.value); setActive(0) }}
              onKeyDown={onKey}
              placeholder={`Type to filter ${label.toLowerCase()}…`}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              style={searchInputStyle}
            />
          )}
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              style={{
                display: "block",
                width: "100%",
                padding: "4px 6px",
                marginBottom: 4,
                background: "transparent",
                border: "none",
                textAlign: "left",
                color: "var(--rpc-text-muted)",
                cursor: "pointer",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
              }}
            >
              Clear ({selected.length})
            </button>
          )}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-multiselectable
            // Focusable only when there is no search box to carry the keys.
            tabIndex={searchable ? -1 : 0}
            aria-activedescendant={searchable ? undefined : activeId}
            onKeyDown={searchable ? undefined : onKey}
            style={{ background: "var(--rpc-surface)", maxHeight: searchable ? 280 : 240, overflowY: "auto", overscrollBehavior: "contain", outline: "none" }}
          >
            {visible.map((opt, i) => {
              const on = selected.includes(opt)
              return (
                <div
                  key={opt}
                  id={`${id}-opt-${i}`}
                  role="option"
                  aria-selected={on}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={e => e.preventDefault()}
                  tabIndex={-1}
                  onClick={() => toggle(opt)}
                  onKeyDown={e => onOptionKey(e, () => toggle(opt))}
                  style={optionStyle(i === active, on)}
                >
                  <span
                    aria-hidden
                    style={{
                      flex: "0 0 14px", width: 14, height: 14, borderRadius: 3,
                      border: "1px solid var(--rpc-border)",
                      background: on ? "var(--rpc-text-primary)" : "transparent",
                      color: "var(--rpc-surface)", fontSize: 10, lineHeight: "12px", textAlign: "center",
                    }}
                  >
                    {on ? "✓" : ""}
                  </span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                    <HighlightedLabel text={fmt(opt)} query={searchable ? query : ""} />
                  </span>
                </div>
              )
            })}
          </div>
          {searchable && query.trim() && visible.length === 0 && <NoMatch query={query} />}
        </div>
      )}
    </div>
  )
}
