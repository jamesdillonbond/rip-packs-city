"use client"

// PackMarketView — the "Packs" body shared by the standalone /[collection]/packs
// route AND the Market tab's Packs sub-section (2026-07-18 IA reorg). It renders
// the per-collection modeling note + <PackPageClient/> (the pack-EV board that
// reads /api/packs → pack_table_rows and renders <PackTable/>, including the
// "My Sealed Packs" wallet strip). Extracted verbatim from packs/page.tsx so the
// route and the sub-section stay byte-identical.

import PackPageClient from "@/components/packs/PackPageClient"
import { getCollection } from "@/lib/collections"

const TS_TIERS = ["ultimate", "legendary", "rare", "fandom", "common"]
const ALLDAY_TIERS = ["ultimate", "legendary", "rare", "premium", "standard", "common"]
// Pinnacle has no Top-Shot-style tier vocabulary (variants/parallels instead),
// so no tier-filter chips.
const PINNACLE_TIERS: string[] = []
// Golazos pack tiers are pack-type descriptors (season × premium), not moment
// rarities — surfaced from pack_table_rows.tier. Premium-first ordering.
const GOLAZOS_TIERS = [
  "historic_premium",
  "in_season_premium",
  "historic_standard",
  "in_season_standard",
]

function ModelNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="note"
      style={{
        margin: "0 0 16px",
        padding: "10px 14px",
        background: "var(--rpc-red-bg)",
        border: "1px solid var(--rpc-red-border)",
        borderRadius: 6,
        fontFamily: "var(--font-mono)",
        fontSize: 12,
        lineHeight: 1.6,
        color: "rgba(255,255,255,0.75)",
      }}
    >
      {children}
    </div>
  )
}

export default function PackMarketView({ collection }: { collection: string }) {
  const collectionObj = getCollection(collection)
  const accent = collectionObj?.accent ?? "var(--rpc-red)"

  if (collection === "disney-pinnacle") {
    return (
      <>
        <ModelNote>
          Pinnacle pack EV is modeled from render supply and live FMV
          (supply-weighted, since Dapper publishes no per-tier pull odds). Very
          low-supply chase packs can show outsized EV on a thin FMV sample —
          check the coverage and sealed/opened counts before trusting a headline
          ratio.
        </ModelNote>
        <PackPageClient
          collection="disney-pinnacle"
          tiers={PINNACLE_TIERS}
          title="Disney Pinnacle — Pack Market"
          accent={accent}
        />
      </>
    )
  }

  if (collection === "laliga-golazos") {
    return (
      <>
        <ModelNote>
          Golazos pack EV is modeled from edition supply and live FMV
          (supply-weighted, since Dapper publishes no per-tier pull odds). Thin-FMV
          packs can show outsized EV on a small sample — check the coverage and
          sealed/opened counts before trusting a headline ratio. Free challenge and
          reward packs (no price, no computed EV) are hidden by default — reveal
          them with the &ldquo;Show $0 / reward packs&rdquo; chip.
        </ModelNote>
        <PackPageClient
          collection="laliga-golazos"
          tiers={GOLAZOS_TIERS}
          title="LaLiga Golazos — Pack Market"
          accent={accent}
        />
      </>
    )
  }

  if (collection === "nfl-all-day") {
    return (
      <>
        <ModelNote>
          NFL All Day has ended primary pack sales — there are no new primary
          drops. Pack prices below reflect the secondary market only.
        </ModelNote>
        <PackPageClient
          collection="nfl-all-day"
          tiers={ALLDAY_TIERS}
          title="NFL All Day — Pack Market"
          accent={accent}
        />
      </>
    )
  }

  return (
    <PackPageClient
      collection="nba-top-shot"
      tiers={TS_TIERS}
      title="NBA Top Shot — Pack Distributions"
      accent={accent}
    />
  )
}
