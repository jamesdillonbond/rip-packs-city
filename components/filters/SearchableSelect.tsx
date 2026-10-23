"use client"

// 2026-10-21 (Trevor): "the filters need to have a typing spot when there's a ton
// of options, like on the teams filter". A native <select> has no place to type on
// a phone (it opens a scroll wheel), so a long single-choice filter renders this
// instead: a button styled like .rpc-filter-select that opens a list with a
// type-to-filter box. Short lists keep the native <select> — use FilterSelect,
// which picks between the two.
//
// Pattern: WAI-ARIA combobox with a listbox popup (select-only trigger + an
// editable filter). Keys in the box: ↓/↑ move, Enter picks, Escape closes and
// returns focus to the trigger, Tab closes. ↓ / Enter / Space on the trigger opens.

import { Fragment, useId, useMemo, useRef, useState } from "react"
import { filterOptions } from "@/lib/filter-match"
import {
  HighlightedLabel, NoMatch, optionStyle, panelStyle, searchInputStyle,
  onOptionKey, useDismissOnOutsidePress, useFocusOnOpen, useKeepInViewport, useScrollActiveIntoView,
} from "@/components/filters/filter-popover"

export { SEARCHABLE_SELECT_MIN } from "@/components/filters/filter-popover"

type Item = { value: string; label: string; group?: string }

export default function SearchableSelect({
  label, value, allValue = "", allLabel, options, onChange, maxWidth, formatOption, fill = false, groupOf,
}: {
  /** Accessible name of the trigger and the list ("Team", "Franchise"). */
  label: string
  value: string
  /** The value meaning "no filter" (e.g. "all"). Omit both for a pick-one list with no "all" row. */
  allValue?: string
  allLabel?: string
  options: string[]
  onChange: (next: string) => void
  maxWidth?: number | string
  /** Display label for an option value (the VALUE still round-trips). */
  formatOption?: (v: string) => string
  /** Fill the parent's width (a grid cell) instead of sizing to the text. */
  fill?: boolean
  /** Heading the option sits under (Panini's sport), like an <optgroup>. Options
   *  must already be in group order; a query also matches the heading. */
  groupOf?: (v: string) => string
}) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const fmt = useMemo(() => formatOption ?? ((v: string) => v), [formatOption])
  const items: Item[] = useMemo(() => {
    const opts = options.map(v => ({ value: v, label: fmt(v), group: groupOf?.(v) }))
    if (!query.trim()) return allLabel === undefined ? opts : [{ value: allValue, label: allLabel }, ...opts]
    // Keep group order (a ranked list would scatter one sport's rows under
    // several repeated headings); rank within each group.
    const ranked = filterOptions(opts, query, o => (o.group ? `${o.label} ${o.group}` : o.label))
    if (!groupOf) return ranked
    const order = new Map<string | undefined, number>()
    for (const o of opts) if (!order.has(o.group)) order.set(o.group, order.size)
    return ranked.map((o, i) => ({ o, i })).sort((a, b) => order.get(a.o.group)! - order.get(b.o.group)! || a.i - b.i).map(x => x.o)
  }, [options, query, allValue, allLabel, fmt, groupOf])

  // Runs of consecutive items sharing a heading → role="group" sections.
  const sections = useMemo(() => {
    const out: Array<{ group?: string; rows: Array<{ it: Item; i: number }> }> = []
    items.forEach((it, i) => {
      const last = out[out.length - 1]
      if (last && last.group === it.group) last.rows.push({ it, i })
      else out.push({ group: it.group, rows: [{ it, i }] })
    })
    return out
  }, [items])

  const openList = () => {
    setQuery("")
    const opts = allLabel === undefined ? options : [allValue, ...options]
    setActive(Math.max(0, opts.indexOf(value)))
    setOpen(true)
  }
  const close = (refocus: boolean) => {
    setOpen(false)
    setQuery("")
    if (refocus) triggerRef.current?.focus()
  }
  const pick = (v: string) => { onChange(v); close(true) }

  useDismissOnOutsidePress(rootRef, open, () => close(false))
  useFocusOnOpen(inputRef, open)
  useKeepInViewport(panelRef, open)
  const activeId = open && items[active] ? `${id}-opt-${active}` : undefined
  useScrollActiveIntoView(activeId)

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => Math.min(items.length - 1, a + 1)) }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === "Enter") { e.preventDefault(); if (items[active]) pick(items[active].value) }
    else if (e.key === "Escape") { e.preventDefault(); close(true) }
    else if (e.key === "Tab") close(false)
  }

  const summary = allLabel !== undefined && value === allValue ? allLabel : fmt(value)

  return (
    <div ref={rootRef} style={{ position: "relative", display: fill ? "block" : "inline-block", width: fill ? "100%" : undefined, minWidth: 0, maxWidth }}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={e => { if (!open && e.key === "ArrowDown") { e.preventDefault(); openList() } }}
        className="rpc-filter-select"
        style={{ width: "100%", maxWidth, textAlign: "left", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {summary}
      </button>
      {open && (
        <div ref={panelRef} style={{ ...panelStyle, minWidth: 240, fontSize: 12 }}>
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
            onKeyDown={onInputKey}
            placeholder={`Type to filter ${label.toLowerCase()}…`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="done"
            style={searchInputStyle}
          />
          <div id={listId} role="listbox" aria-label={label} style={{ maxHeight: 300, overflowY: "auto", overscrollBehavior: "contain" }}>
            {sections.map((sec, si) => {
              const rows = sec.rows.map(({ it, i }) => (
              <div
                key={it.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={it.value === value}
                onMouseEnter={() => setActive(i)}
                // mousedown keeps focus in the box (no blur flicker); click picks.
                onMouseDown={e => e.preventDefault()}
                tabIndex={-1}
                onClick={() => pick(it.value)}
                onKeyDown={e => onOptionKey(e, () => pick(it.value))}
                style={optionStyle(i === active, it.value === value)}
              >
                <span aria-hidden style={{ width: 12, flex: "0 0 12px", color: "var(--rpc-text-primary)" }}>{it.value === value ? "✓" : ""}</span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  <HighlightedLabel text={it.label} query={query} />
                </span>
              </div>
              ))
              if (sec.group === undefined) return <Fragment key={`s${si}`}>{rows}</Fragment>
              return (
                <div key={`s${si}`} role="group" aria-label={sec.group}>
                  <div aria-hidden style={groupHeadingStyle}>{sec.group}</div>
                  {rows}
                </div>
              )
            })}
          </div>
          {query.trim() && items.length === 0 && <NoMatch query={query} />}
        </div>
      )}
    </div>
  )
}

const groupHeadingStyle: React.CSSProperties = {
  padding: "8px 10px 4px", fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase",
  color: "var(--rpc-text-muted)", position: "sticky", top: 0, background: "var(--rpc-surface)",
}
