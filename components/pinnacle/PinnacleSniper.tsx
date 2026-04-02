"use client"

import { useState, useEffect, useCallback } from "react"
import PinnacleListingCard from "./PinnacleListingCard"
import LoadingState from "@/components/ui/LoadingState"
import EmptyState from "@/components/ui/EmptyState"

// ─── Filter options ──────────────────────────────────────────────────────────

const VARIANTS = [
  "Standard", "Silver Sparkle", "Brushed Silver", "Radiant Chrome",
  "Luxe Marble", "Golden", "Digital Display", "Color Splash",
  "Colored Enamel", "Embellished Enamel", "Apex", "Quartis",
  "Quinova", "Xenith",
]

const EDITION_TYPES = [
  "Open Edition", "Open Event Edition", "Limited Edition",
  "Limited Event Edition", "Legendary Edition", "Starter Edition",
]

const STUDIOS = [
  "Walt Disney Animation Studios",
  "Pixar Animation Studios",
  "Lucasfilm Ltd.",
  "20th Century Studios",
]

const SORT_OPTIONS = [
  { value: "price_asc", label: "Price: Low to High" },
  { value: "price_desc", label: "Price: High to Low" },
  { value: "serial_asc", label: "Serial: Low to High" },
]

// ─── Types ───────────────────────────────────────────────────────────────────

interface ListingEdition {
  id: string
  character_name: string
  set_name: string
  variant_type: string
  edition_type: string
  franchise: string
  is_serialized: boolean
  is_chaser: boolean
  series_year: number | null
  royalty_code: string | null
  floor_price_usd: number | null
  pinnacle_fmv_snapshots: {
    fmv_usd: number
    floor_usd: number | null
    confidence: string
    computed_at: string
  }[]
}

// ─── Multi-select filter component ──────────────────────────────────────────

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string
  options: string[]
  selected: string[]
  onChange: (val: string[]) => void
}) {
  const toggle = (opt: string) => {
    onChange(
      selected.includes(opt)
        ? selected.filter((s) => s !== opt)
        : [...selected, opt]
    )
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ color: "#94a3b8", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {options.map((opt) => {
          const active = selected.includes(opt)
          return (
            <button
              key={opt}
              onClick={() => toggle(opt)}
              style={{
                background: active ? "#7c3aed30" : "#1e293b",
                color: active ? "#a78bfa" : "#64748b",
                border: `1px solid ${active ? "#7c3aed50" : "#334155"}`,
                fontSize: 11,
                padding: "3px 10px",
                borderRadius: 6,
                cursor: "pointer",
                transition: "all 0.15s",
                fontWeight: active ? 600 : 400,
              }}
            >
              {opt}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function PinnacleSniper() {
  const [listings, setListings] = useState<ListingEdition[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [variants, setVariants] = useState<string[]>([])
  const [editionTypes, setEditionTypes] = useState<string[]>([])
  const [studios, setStudios] = useState<string[]>([])
  const [chaserOnly, setChaserOnly] = useState(false)
  const [sortBy, setSortBy] = useState("price_asc")

  const fetchListings = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (variants.length) params.set("variant", variants.join(","))
      if (editionTypes.length) params.set("editionType", editionTypes.join(","))
      if (studios.length) params.set("studio", studios.join(","))
      if (chaserOnly) params.set("isChaser", "true")
      params.set("sortBy", sortBy)
      params.set("limit", "100")

      const res = await fetch(`/api/pinnacle/listings?${params}`)
      if (!res.ok) throw new Error(`API returned ${res.status}`)

      const json = await res.json()
      setListings(json.data ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load listings")
    } finally {
      setLoading(false)
    }
  }, [variants, editionTypes, studios, chaserOnly, sortBy])

  useEffect(() => {
    fetchListings()
  }, [fetchListings])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Filter bar */}
      <div
        style={{
          background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%)",
          border: "1px solid rgba(139, 92, 246, 0.15)",
          borderRadius: 12,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <MultiSelect
          label="Variant"
          options={VARIANTS}
          selected={variants}
          onChange={setVariants}
        />

        <MultiSelect
          label="Edition Type"
          options={EDITION_TYPES}
          selected={editionTypes}
          onChange={setEditionTypes}
        />

        <MultiSelect
          label="Studio"
          options={STUDIOS}
          selected={studios}
          onChange={setStudios}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          {/* Chaser toggle */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "#94a3b8",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={chaserOnly}
              onChange={(e) => setChaserOnly(e.target.checked)}
              style={{ accentColor: "#7c3aed" }}
            />
            Chasers only
          </label>

          {/* Sort dropdown */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            style={{
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "4px 10px",
              fontSize: 12,
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
      {loading && <LoadingState lines={4} />}

      {!loading && error && (
        <EmptyState
          icon="⚠️"
          title="Failed to load listings"
          subtitle={error}
        />
      )}

      {!loading && !error && listings.length === 0 && (
        <EmptyState
          icon="📌"
          title="No pins found"
          subtitle="Try adjusting your filters or check back later."
        />
      )}

      {!loading && !error && listings.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
            gap: 12,
          }}
        >
          {listings.map((edition) => (
            <PinnacleListingCard
              key={edition.id}
              editionKey={edition.id}
              setName={edition.set_name}
              characters={edition.character_name}
              variant={edition.variant_type}
              editionType={edition.edition_type}
              seriesName={edition.royalty_code ?? "—"}
              franchise={edition.franchise}
              floorPrice={edition.floor_price_usd}
              serial={null}
              isSerialized={edition.is_serialized}
              isChaser={edition.is_chaser}
              isLocked={false}
            />
          ))}
        </div>
      )}
    </div>
  )
}
