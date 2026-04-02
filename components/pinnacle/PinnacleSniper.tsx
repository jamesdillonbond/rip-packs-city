"use client"

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import PinnacleListingCard from "./PinnacleListingCard"
import type { PinnacleEdition } from "@/lib/pinnacle/types"
import {
  PINNACLE_VARIANTS,
  PINNACLE_EDITION_TYPES,
  PINNACLE_STUDIOS,
} from "@/lib/pinnacle/types"

// ─── Filter state ────────────────────────────────────────────────────────────

type SortOption = "price_asc" | "price_desc" | "serial_asc"

function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value)
    ? arr.filter((v) => v !== value)
    : [...arr, value]
}

// ─── Skeleton loader ─────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-slate-700/50 bg-slate-800/50 p-4">
      <div className="mb-3 h-20 rounded-lg bg-slate-700/50" />
      <div className="mb-2 h-4 w-3/4 rounded bg-slate-700/50" />
      <div className="mb-2 h-3 w-1/2 rounded bg-slate-700/50" />
      <div className="mb-3 flex gap-1.5">
        <div className="h-5 w-16 rounded-full bg-slate-700/50" />
        <div className="h-5 w-20 rounded-full bg-slate-700/50" />
      </div>
      <div className="mt-auto flex items-end justify-between">
        <div className="h-6 w-16 rounded bg-slate-700/50" />
        <div className="h-8 w-14 rounded-lg bg-slate-700/50" />
      </div>
    </div>
  )
}

// ─── Multi-select dropdown ───────────────────────────────────────────────────

function MultiSelect({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string
  options: readonly string[]
  selected: string[]
  onToggle: (value: string) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500"
      >
        {label}
        {selected.length > 0 && (
          <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-400">
            {selected.length}
          </span>
        )}
        <svg className="h-3 w-3 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <>
          {/* Backdrop to close */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 max-h-60 w-56 overflow-y-auto rounded-lg border border-slate-600 bg-slate-800 shadow-xl">
            {options.map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => onToggle(opt)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-slate-700 ${
                  selected.includes(opt) ? "text-amber-400" : "text-slate-300"
                }`}
              >
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[8px] ${
                    selected.includes(opt)
                      ? "border-amber-500 bg-amber-500/20 text-amber-400"
                      : "border-slate-600"
                  }`}
                >
                  {selected.includes(opt) && "✓"}
                </span>
                {opt}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ─── Main Sniper Component ───────────────────────────────────────────────────

export default function PinnacleSniper() {
  const [selectedVariants, setSelectedVariants] = useState<string[]>([])
  const [selectedEditionTypes, setSelectedEditionTypes] = useState<string[]>([])
  const [selectedStudios, setSelectedStudios] = useState<string[]>([])
  const [chaserOnly, setChaserOnly] = useState(false)
  const [sortBy, setSortBy] = useState<SortOption>("price_asc")

  // Build query params
  const queryParams = new URLSearchParams()
  if (selectedVariants.length > 0) queryParams.set("variant", selectedVariants.join(","))
  if (selectedEditionTypes.length > 0) queryParams.set("editionType", selectedEditionTypes.join(","))
  if (selectedStudios.length > 0) queryParams.set("studio", selectedStudios.join(","))
  if (chaserOnly) queryParams.set("isChaser", "true")
  queryParams.set("sortBy", sortBy)
  queryParams.set("limit", "100")

  const { data, isLoading, error } = useQuery({
    queryKey: [
      "pinnacle-listings",
      selectedVariants,
      selectedEditionTypes,
      selectedStudios,
      chaserOnly,
      sortBy,
    ],
    queryFn: async () => {
      const res = await fetch(`/api/pinnacle/listings?${queryParams.toString()}`)
      if (!res.ok) throw new Error("Failed to fetch listings")
      return res.json() as Promise<{ listings: PinnacleEdition[] }>
    },
    refetchInterval: 60_000,
  })

  const listings = data?.listings ?? []

  return (
    <div>
      {/* ─── Filter Bar ───────────────────────────────────────────────── */}
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <MultiSelect
          label="Variant"
          options={PINNACLE_VARIANTS}
          selected={selectedVariants}
          onToggle={(v) => setSelectedVariants(toggleInArray(selectedVariants, v))}
        />

        <MultiSelect
          label="Edition Type"
          options={PINNACLE_EDITION_TYPES}
          selected={selectedEditionTypes}
          onToggle={(v) => setSelectedEditionTypes(toggleInArray(selectedEditionTypes, v))}
        />

        <MultiSelect
          label="Studio"
          options={PINNACLE_STUDIOS}
          selected={selectedStudios}
          onToggle={(v) => setSelectedStudios(toggleInArray(selectedStudios, v))}
        />

        {/* Chaser toggle */}
        <button
          type="button"
          onClick={() => setChaserOnly(!chaserOnly)}
          className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            chaserOnly
              ? "border-red-500 bg-red-500/20 text-red-400"
              : "border-slate-600 bg-slate-800 text-slate-300 hover:border-slate-500"
          }`}
        >
          Chaser Only
        </button>

        {/* Sort dropdown */}
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortOption)}
          className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 outline-none transition-colors hover:border-slate-500"
        >
          <option value="price_asc">Price: Low → High</option>
          <option value="price_desc">Price: High → Low</option>
          <option value="serial_asc">Oldest First</option>
        </select>
      </div>

      {/* ─── Error ────────────────────────────────────────────────────── */}
      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">
          Failed to load listings. Please try again.
        </div>
      )}

      {/* ─── Grid ─────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 12 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : listings.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-500">
          <p className="text-4xl mb-3">📌</p>
          <p className="text-sm">No pins found matching your filters.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
          {listings.map((edition) => (
            <PinnacleListingCard key={edition.edition_key} edition={edition} />
          ))}
        </div>
      )}
    </div>
  )
}
