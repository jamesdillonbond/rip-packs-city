"use client"

// Free-text filter box with suggestions (market Player). Replaces a native
// <datalist>, which matched accent-SENSITIVELY — "doncic" offered nothing for
// "Luka Dončić", and the route's ilike then matched no listing either, so the
// board read as an empty market for a player with live asks — and which renders
// thousands of <option>s poorly on a phone.
//
// The typed text IS the filter (onChange on every keystroke, as before); a
// suggestion replaces it with the exact catalog spelling the route can match.
// Pattern: WAI-ARIA combobox, list autocomplete. ↓/↑ move, Enter takes the
// active suggestion, Escape closes the list (keeps the text), Tab closes.

import { useId, useMemo, useRef, useState } from "react"
import { filterOptions } from "@/lib/filter-match"
import {
  HighlightedLabel, onOptionKey, optionStyle, panelStyle,
  useDismissOnOutsidePress, useKeepInViewport, useScrollActiveIntoView,
} from "@/components/filters/filter-popover"

const MAX_SUGGESTIONS = 8

export default function Autocomplete({
  label, value, onChange, suggestions, placeholder, inputStyle,
}: {
  /** Accessible name ("Search by player"). */
  label: string
  value: string
  onChange: (next: string) => void
  suggestions: string[]
  placeholder?: string
  inputStyle?: React.CSSProperties
}) {
  const id = useId()
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  const matches = useMemo(() => {
    const typed = value.trim()
    if (!typed) return []
    // Drop only a VERBATIM match: "luka doncic" must still offer "Luka Dončić",
    // the spelling the route's ilike can find.
    return filterOptions(suggestions, value)
      .filter(s => s !== typed)
      .slice(0, MAX_SUGGESTIONS)
  }, [suggestions, value])
  const showList = open && matches.length > 0

  const close = () => { setOpen(false); setActive(-1) }
  const take = (s: string) => { onChange(s); close() }

  useDismissOnOutsidePress(rootRef, showList, close)
  useKeepInViewport(panelRef, showList)
  const activeId = showList && active >= 0 ? `${id}-opt-${active}` : undefined
  useScrollActiveIntoView(activeId)

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setOpen(true)
      setActive(a => Math.min(matches.length - 1, a + 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setActive(a => Math.max(-1, a - 1))
    } else if (e.key === "Enter" && showList && active >= 0) {
      e.preventDefault()
      take(matches[active])
    } else if (e.key === "Escape" && showList) {
      e.preventDefault()
      close()
    } else if (e.key === "Tab") {
      close()
    }
  }

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-block" }}>
      <input
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={showList ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        value={value}
        placeholder={placeholder}
        onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
        style={inputStyle}
      />
      {showList && (
        <div ref={panelRef} style={{ ...panelStyle, minWidth: 220, fontSize: 11 }}>
          <div id={listId} role="listbox" aria-label={`${label} suggestions`} style={{ maxHeight: 300, overflowY: "auto", overscrollBehavior: "contain" }}>
            {matches.map((s, i) => (
              <div
                key={s}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={i === active}
                tabIndex={-1}
                onMouseEnter={() => setActive(i)}
                onMouseDown={e => e.preventDefault()}
                onClick={() => take(s)}
                onKeyDown={e => onOptionKey(e, () => take(s))}
                style={optionStyle(i === active, false)}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                  <HighlightedLabel text={s} query={value} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
