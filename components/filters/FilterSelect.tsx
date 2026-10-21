"use client"

// A single-choice filter: the native <select> while the list is short (the
// platform control is the best one there — the OS picker on a phone, type-ahead
// on a desktop), the searchable list once it is long enough that scrolling a
// phone's picker wheel stops being reasonable.

import SearchableSelect, { SEARCHABLE_SELECT_MIN } from "@/components/filters/SearchableSelect"

export default function FilterSelect({
  label, value, allValue = "all", allLabel, options, onChange, formatOption, className = "rpc-filter-select", style, maxWidth, fill = false,
}: {
  /** Accessible name ("Team", "Filter by set"). */
  label: string
  value: string
  allValue?: string
  allLabel: string
  /** The choices, WITHOUT the "all" entry. */
  options: string[]
  onChange: (next: string) => void
  formatOption?: (v: string) => string
  className?: string
  style?: React.CSSProperties
  maxWidth?: number | string
  /** Fill the parent's width (a grid cell). */
  fill?: boolean
}) {
  if (options.length > SEARCHABLE_SELECT_MIN) {
    return (
      <SearchableSelect
        label={label} value={value} allValue={allValue} allLabel={allLabel}
        options={options} onChange={onChange} formatOption={formatOption} maxWidth={maxWidth} fill={fill}
      />
    )
  }
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} className={className} style={{ maxWidth, ...style }}>
      <option value={allValue}>{allLabel}</option>
      {options.map(v => <option key={v} value={v}>{formatOption ? formatOption(v) : v}</option>)}
    </select>
  )
}
