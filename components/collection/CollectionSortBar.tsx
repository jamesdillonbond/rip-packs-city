"use client"

// Presentational sort/toggle row for the wallet-collection viewer
// (app/(collections)/[collection]/collection/page.tsx) — Step 3b of the
// monolith extraction (follows CollectionFilterBar). Behavior-preserving:
// sort buttons + quick-filter toggles read/write the view reducer via
// {view, dispatchView}; the CSV-export builder, the Pro-allowlist gate, and
// the debug handlers stay in the page and arrive as props, so this component
// owns layout only. No data-fetch logic here.
import type {
  CollectionViewState,
  CollectionViewAction,
} from "@/lib/collection/view-reducer"
import type { SortKey } from "@/lib/collection/types"

export default function CollectionSortBar(props: {
  view: CollectionViewState
  dispatchView: React.Dispatch<CollectionViewAction>
  toggleSort: (key: SortKey) => void
  showLoanDefaultsToggle: boolean
  showCsvButtons: boolean
  onExportCsv: () => void
  fullCsvHref: string
  debugMode: boolean
  showDebug: boolean
  onToggleShowDebug: () => void
  onCopySeeds: () => void
}) {
  const {
    view, dispatchView, toggleSort, showLoanDefaultsToggle, showCsvButtons,
    onExportCsv, fullCsvHref, debugMode, showDebug, onToggleShowDebug, onCopySeeds,
  } = props
  return (
    <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
      {([
        ["acquired", "Recent"],
        ["fmv", "FMV"],
        ["paid", "Paid"],
        ["player", "Player"],
        ["series", "Series"],
        ["set", "Set"],
        ["parallel", "Parallel"],
        ["rarity", "Rarity"],
        ["serial", "Serial"],
        ["held", "Held"],
        ["bestOffer", "Best Offer"],
        ["badge", "Badge"],
      ] as [SortKey, string][]).map(function([key, label]) {
        return (
          <button key={key} onClick={function() { toggleSort(key) }} className={"rpc-filter-button shrink-0" + (view.sortKey === key ? " rpc-filter-button--active" : "")}>
            {label}{view.sortKey === key && <span style={{ marginLeft: 4, opacity: 0.7 }}>{view.sortDirection === "asc" ? "↑" : "↓"}</span>}
          </button>
        )
      })}
      <div className="border-l border-[color:var(--rpc-border-hover)] mx-1" />
      <button onClick={function() { dispatchView({ type: "SET", field: "filterBadges", value: !view.filterBadges }) }} className={"rpc-filter-toggle shrink-0" + (view.filterBadges ? " rpc-filter-toggle--active" : "")}>🏷 BADGES</button>
      <button onClick={function() { dispatchView({ type: "SET", field: "filterHasOffer", value: !view.filterHasOffer }) }} className={"rpc-filter-toggle shrink-0" + (view.filterHasOffer ? " rpc-filter-toggle--active" : "")}>💰 HAS OFFER</button>
      <button onClick={function() { dispatchView({ type: "SET", field: "filterListed", value: !view.filterListed }) }} className={"rpc-filter-toggle shrink-0" + (view.filterListed ? " rpc-filter-toggle--active" : "")}>📋 LISTED</button>
      {showLoanDefaultsToggle && (
        <button onClick={function() { dispatchView({ type: "SET", field: "filterLoanDefaultsOnly", value: !view.filterLoanDefaultsOnly }) }} className={"rpc-filter-toggle shrink-0" + (view.filterLoanDefaultsOnly ? " rpc-filter-toggle--active" : "")} title="Show only moments acquired via loan default">⚖ LOAN DEFAULTS</button>
      )}
      {/* Task 6: CSV Export — gated to the Pro allowlist (hidden, not prompted, for others) */}
      {showCsvButtons && (
        <button onClick={onExportCsv} className="rpc-filter-button shrink-0">
          Export CSV
        </button>
      )}
      {showCsvButtons && (
        <a
          href={fullCsvHref}
          target="_blank"
          rel="noopener noreferrer"
          className="rpc-filter-button shrink-0 inline-flex items-center gap-1"
          title="Download all moments as CSV"
        >
          ⬇ Full CSV
        </a>
      )}
      {debugMode && (
        <>
          <button onClick={onToggleShowDebug} className="rpc-filter-button shrink-0">{showDebug ? "Hide Debug" : "Debug"}</button>
          <button onClick={onCopySeeds} className="rpc-filter-button shrink-0">Copy Seeds</button>
        </>
      )}
    </div>
  )
}
