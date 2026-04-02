"use client"

import type { PinnacleEdition } from "@/lib/pinnacle/types"

// ─── Variant badge colors ────────────────────────────────────────────────────

const VARIANT_COLORS: Record<string, { bg: string; text: string }> = {
  Standard:           { bg: "bg-slate-700",    text: "text-slate-200" },
  "Silver Sparkle":   { bg: "bg-gray-400",     text: "text-gray-900" },
  "Brushed Silver":   { bg: "bg-gray-500",     text: "text-white" },
  "Radiant Chrome":   { bg: "bg-sky-400",      text: "text-sky-950" },
  "Luxe Marble":      { bg: "bg-stone-300",    text: "text-stone-900" },
  Golden:             { bg: "bg-amber-400",     text: "text-amber-950" },
  "Digital Display":  { bg: "bg-cyan-500",     text: "text-cyan-950" },
  "Color Splash":     { bg: "bg-pink-500",     text: "text-white" },
  "Colored Enamel":   { bg: "bg-emerald-500",  text: "text-emerald-950" },
  "Embellished Enamel": { bg: "bg-violet-500", text: "text-white" },
  Apex:               { bg: "bg-red-600",      text: "text-white" },
  Quartis:            { bg: "bg-indigo-500",    text: "text-white" },
  Quinova:            { bg: "bg-fuchsia-500",   text: "text-white" },
  Xenith:             { bg: "bg-yellow-300",    text: "text-yellow-900" },
}

function getVariantStyle(variant: string | null) {
  return VARIANT_COLORS[variant ?? ""] ?? { bg: "bg-slate-600", text: "text-slate-200" }
}

// ─── Edition type badge style ────────────────────────────────────────────────

function getEditionTypeBadgeClass(editionType: string | null): string {
  if (editionType?.includes("Limited")) return "border-amber-500/60 text-amber-300"
  if (editionType?.includes("Legendary")) return "border-purple-500/60 text-purple-300"
  if (editionType?.includes("Starter")) return "border-green-500/60 text-green-300"
  return "border-slate-500/60 text-slate-300"
}

// ─── Component ───────────────────────────────────────────────────────────────

interface Props {
  edition: PinnacleEdition
}

export default function PinnacleListingCard({ edition }: Props) {
  const variantStyle = getVariantStyle(edition.variant)
  const editionTypeBadge = getEditionTypeBadgeClass(edition.edition_type)

  return (
    <div className="relative flex flex-col rounded-xl border border-slate-700/50 bg-gradient-to-b from-slate-800/90 to-slate-900/90 p-4 transition-all hover:border-amber-500/30 hover:shadow-lg hover:shadow-amber-500/5">
      {/* Pin emoji placeholder */}
      <div className="mb-3 flex h-20 items-center justify-center rounded-lg bg-slate-800/50 text-4xl">
        📌
      </div>

      {/* Set & Series */}
      <h3 className="mb-1 text-sm font-semibold text-white leading-tight truncate">
        {edition.set_name ?? "Unknown Set"}
      </h3>
      {edition.series_name && (
        <p className="mb-2 text-xs text-slate-400 truncate">
          {edition.series_name}
        </p>
      )}

      {/* Characters */}
      {edition.characters && (
        <p className="mb-2 text-xs text-amber-300/80 truncate">
          {edition.characters}
        </p>
      )}

      {/* Badges row */}
      <div className="mb-3 flex flex-wrap gap-1.5">
        {/* Variant badge */}
        {edition.variant && (
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${variantStyle.bg} ${variantStyle.text}`}
          >
            {edition.variant}
          </span>
        )}

        {/* Edition type badge */}
        {edition.edition_type && (
          <span
            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${editionTypeBadge}`}
          >
            {edition.edition_type}
          </span>
        )}

        {/* Chaser badge */}
        {edition.is_chaser && (
          <span className="inline-flex items-center rounded-full bg-red-600/80 px-2 py-0.5 text-[10px] font-bold text-white uppercase tracking-wide">
            Chaser
          </span>
        )}
      </div>

      {/* Studio */}
      {edition.studios && (
        <p className="mb-2 text-[10px] text-slate-500 truncate">
          {edition.studios}
        </p>
      )}

      {/* Listings count */}
      <p className="mb-3 text-[10px] text-slate-500">
        {edition.listings_count} listed
      </p>

      {/* Price + Buy */}
      <div className="mt-auto flex items-end justify-between">
        <div>
          {edition.floor_price_usd !== null ? (
            <p className="text-lg font-bold text-white">
              ${edition.floor_price_usd.toFixed(2)}
            </p>
          ) : (
            <p className="text-sm text-slate-500">No price</p>
          )}
        </div>

        <a
          href="https://disneypinnacle.com/marketplace"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-bold text-slate-900 transition-colors hover:bg-amber-400"
        >
          Buy
        </a>
      </div>
    </div>
  )
}
