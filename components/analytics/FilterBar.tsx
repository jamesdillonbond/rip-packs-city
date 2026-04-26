"use client"

import { ChevronDown } from "lucide-react"
import { useState } from "react"

export type LoanWindow = "L7" | "L30" | "L90" | "YTD" | "2026" | "2025" | "ALL"

interface CollectionChip {
  key: string
  label: string
}

const WINDOW_OPTIONS: Array<{ value: LoanWindow; label: string }> = [
  { value: "L7", label: "L7" },
  { value: "L30", label: "L30" },
  { value: "L90", label: "L90" },
  { value: "YTD", label: "YTD" },
  { value: "2026", label: "2026" },
  { value: "2025", label: "2025" },
  { value: "ALL", label: "All time" },
]

interface FilterBarProps {
  title: string
  subtitle: string
  collections: CollectionChip[]
  activeCollections: string[]
  onCollectionsChange: (next: string[]) => void
  window: LoanWindow
  onWindowChange: (w: LoanWindow) => void
}

export default function FilterBar({
  title,
  subtitle,
  collections,
  activeCollections,
  onCollectionsChange,
  window,
  onWindowChange,
}: FilterBarProps) {
  const [open, setOpen] = useState(false)

  function toggle(key: string) {
    if (activeCollections.includes(key)) {
      onCollectionsChange(activeCollections.filter((c) => c !== key))
    } else {
      onCollectionsChange([...activeCollections, key])
    }
  }

  function reset() {
    onCollectionsChange([])
  }

  const selectedLabel = WINDOW_OPTIONS.find((o) => o.value === window)?.label ?? "All time"
  const allActive = activeCollections.length === 0

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-50 tracking-tight">{title}</h1>
          <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
        </div>

        <div className="relative flex-shrink-0">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:border-emerald-500/50 transition-colors"
          >
            <span className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Window
            </span>
            <span>{selectedLabel}</span>
            <ChevronDown size={14} className="text-slate-500" />
          </button>
          {open ? (
            <div
              className="absolute right-0 top-full mt-1 z-20 w-40 rounded-md border border-slate-700 bg-slate-900 shadow-xl"
              onMouseLeave={() => setOpen(false)}
            >
              {WINDOW_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onWindowChange(o.value)
                    setOpen(false)
                  }}
                  className={
                    "block w-full text-left px-3 py-1.5 text-sm transition-colors " +
                    (o.value === window
                      ? "text-emerald-400 bg-emerald-500/10"
                      : "text-slate-300 hover:bg-slate-800")
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className={
            "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
            (allActive
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
              : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200")
          }
        >
          All
        </button>
        {collections.map((c) => {
          const active = activeCollections.includes(c.key)
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => toggle(c.key)}
              className={
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                (active
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                  : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200")
              }
            >
              {c.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
