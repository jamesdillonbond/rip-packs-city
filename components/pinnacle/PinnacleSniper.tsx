"use client"

import { useState, useEffect, useCallback } from "react"
import PinnacleListingCard from "./PinnacleListingCard"
import LoadingState from "@/components/ui/LoadingState"
import EmptyState from "@/components/ui/EmptyState"
import type { PinnacleEdition } from "@/lib/pinnacle/types"

// ── Filter options ───────────────────────────────────────────────

const VARIANT_OPTIONS = [
  "Standard", "Silver Sparkle", "Brushed Silver", "Radiant Chrome",
  "Luxe Marble", "Golden", "Digital Display", "Color Splash",
  "Colored Enamel", "Embellished Enamel", "Apex", "Quartis", "Quinova", "Xenith",
]

const EDITION_TYPE_OPTIONS = [
  "Open Edition", "Open Event Edition", "Limited Edition",
  "Limited Event Edition", "Legendary Edition", "Starter Edition",
]

const STUDIO_OPTIONS = [
  "Walt Disney Animation Studios",
  "Pixar Animation Studios",
  "Lucasfilm Ltd.",
  "20th Century Studios",
]

const SORT_OPTIONS = [
  { value: "price_asc", label: "Price: Low → High" },
  { value: "price_desc", label: "Price: High → Low" },
  { value: "serial_asc", label: "Edition A → Z" },
]

type SortBy = "price_asc" | "price_desc" | "serial_asc"

// ── Component ────────────────────────────────────────────────────

export default function PinnacleSniper() {
  const [listings, setListings] = useState<PinnacleEdition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [selectedVariants, setSelectedVariants] = useState<Set<string>>(new Set())
  const [selectedEditionTypes, setSelectedEditionTypes] = useState<Set<string>>(new Set())
  const [selectedStudios, setSelectedStudios] = useState<Set<string>>(new Set())
  const [chaserOnly, setChaserOnly] = useState(false)
  const [sortBy, setSortBy] = useState<SortBy>("price_asc")

  const fetchListings = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()

      selectedVariants.forEach((v) => params.append("variant", v))
      selectedEditionTypes.forEach((e) => params.append("editionType", e))
      selectedStudios.forEach((s) => params.append("studio", s))
      if (chaserOnly) params.set("isChaser", "true")
      params.set("sortBy", sortBy)
      params.set("limit", "100")

      const res = await fetch(`/api/pinnacle/listings?${params.toString()}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      setListings(data.listings ?? [])
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [selectedVariants, selectedEditionTypes, selectedStudios, chaserOnly, sortBy])

  useEffect(() => {
    fetchListings()
  }, [fetchListings])

  // ── Toggle helpers ─────────────────────────────────────────────
  function toggleInSet(set: Set<string>, value: string): Set<string> {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  return (
    <div>
      {/* Filter bar */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 12,
          marginBottom: 20,
          padding: "16px 18px",
          background: "var(--rpc-surface-raised)",
          border: "1px solid var(--rpc-border)",
          borderRadius: "var(--radius-md)",
        }}
      >
        {/* Variant multi-select */}
        <FilterSection label="VARIANT">
          {VARIANT_OPTIONS.map((v) => (
            <button
              key={v}
              className={`rpc-chip ${selectedVariants.has(v) ? "active" : ""}`}
              onClick={() => setSelectedVariants(toggleInSet(selectedVariants, v))}
            >
              {v}
            </button>
          ))}
        </FilterSection>

        {/* Edition Type multi-select */}
        <FilterSection label="EDITION TYPE">
          {EDITION_TYPE_OPTIONS.map((e) => (
            <button
              key={e}
              className={`rpc-chip ${selectedEditionTypes.has(e) ? "active" : ""}`}
              onClick={() => setSelectedEditionTypes(toggleInSet(selectedEditionTypes, e))}
            >
              {e}
            </button>
          ))}
        </FilterSection>

        {/* Studio multi-select */}
        <FilterSection label="STUDIO">
          {STUDIO_OPTIONS.map((s) => (
            <button
              key={s}
              className={`rpc-chip ${selectedStudios.has(s) ? "active" : ""}`}
              onClick={() => setSelectedStudios(toggleInSet(selectedStudios, s))}
            >
              {s}
            </button>
          ))}
        </FilterSection>

        {/* Toggles + sort */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {/* Chaser toggle */}
          <button
            className={`rpc-chip ${chaserOnly ? "active" : ""}`}
            onClick={() => setChaserOnly(!chaserOnly)}
          >
            ⭐ Chaser Only
          </button>

          {/* Sort dropdown */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortBy)}
            style={{
              marginLeft: "auto",
              background: "rgba(255,255,255,0.05)",
              border: "1px solid rgba(255,255,255,0.09)",
              color: "var(--rpc-text-secondary)",
              padding: "4px 10px",
              borderRadius: 3,
              fontSize: 10,
              fontFamily: "var(--font-mono)",
              letterSpacing: "0.1em",
              cursor: "pointer",
            }}
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Results */}
      {loading ? (
        <LoadingState lines={6} />
      ) : error ? (
        <EmptyState
          icon="⚠️"
          title="Failed to load listings"
          subtitle={error}
        />
      ) : listings.length === 0 ? (
        <EmptyState
          icon="📌"
          title="No pins found"
          subtitle="Try adjusting your filters or sync data first via the API."
        />
      ) : (
        <>
          <div
            style={{
              fontSize: "var(--text-xs)",
              fontFamily: "var(--font-mono)",
              color: "var(--rpc-text-muted)",
              letterSpacing: "0.15em",
              marginBottom: 12,
            }}
          >
            {listings.length} PIN{listings.length !== 1 ? "S" : ""} FOUND
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
              gap: 12,
            }}
          >
            {listings.map((edition) => (
              <PinnacleListingCard
                key={edition.edition_key}
                edition={edition}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Filter Section Helper ────────────────────────────────────────

function FilterSection({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div
        style={{
          fontSize: "var(--text-xs)",
          fontFamily: "var(--font-mono)",
          color: "var(--rpc-text-muted)",
          letterSpacing: "0.15em",
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {children}
      </div>
    </div>
  )
}
