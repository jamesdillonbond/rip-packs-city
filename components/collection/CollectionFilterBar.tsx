"use client"

// Presentational filter-select grid for the wallet-collection viewer
// (app/(collections)/[collection]/collection/page.tsx). Behavior-preserving
// extraction — reads/writes the view reducer via {view, dispatchView} and the
// option arrays the page already derives. No data-fetch logic here.
import LeagueFilter from "@/components/filters/LeagueFilter"
import FilterSelect from "@/components/filters/FilterSelect"
import { collectionHasLocking } from "@/lib/collections"
import { getEntityLabels } from "@/lib/entity-labels"
import { isPinnacleUrlSlug } from "@/lib/collection-slug"
import type {
  CollectionViewState,
  CollectionViewAction,
} from "@/lib/collection/view-reducer"

// The option arrays arrive with the "all" sentinel first; FilterSelect adds its own.
function withoutAll(opts: string[]): string[] {
  return opts.filter(function(o) { return o !== "all" })
}

export default function CollectionFilterBar(props: {
  view: CollectionViewState
  dispatchView: React.Dispatch<CollectionViewAction>
  availablePlayers: string[]
  availableSets: string[]
  availableSeries: string[]
  availableRarities: string[]
  collectionSlug: string
}) {
  const { view, dispatchView, availablePlayers, availableSets, availableSeries, availableRarities, collectionSlug } = props
  return (
    <div className="mb-5 grid gap-2 grid-cols-2 sm:grid-cols-3 xl:grid-cols-7">
      {/* Player / Set / Series lists run to hundreds on a big wallet: past
          SEARCHABLE_SELECT_MIN they get a type-to-filter box (FilterSelect). */}
      <FilterSelect fill label={"Filter by " + getEntityLabels(collectionSlug).players.toLowerCase()} value={view.playerFilter} allLabel={"All " + getEntityLabels(collectionSlug).players} options={withoutAll(availablePlayers)} onChange={function(v) { dispatchView({ type: "SET", field: "playerFilter", value: v }) }} />
      <FilterSelect fill label="Filter by set" value={view.setFilter} allLabel="All Sets" options={withoutAll(availableSets)} onChange={function(v) { dispatchView({ type: "SET", field: "setFilter", value: v }) }} />
      <FilterSelect fill label="Filter by series" value={view.seriesFilter} allLabel="All Series" options={withoutAll(availableSeries)} onChange={function(v) { dispatchView({ type: "SET", field: "seriesFilter", value: v }) }} />
      <select aria-label={isPinnacleUrlSlug(collectionSlug) ? "Filter by variant" : "Filter by rarity"} value={view.rarityFilter} onChange={function(e) { dispatchView({ type: "SET", field: "rarityFilter", value: e.target.value }) }} className="rpc-filter-select">
        {availableRarities.map(function(tier) { return <option key={tier} value={tier}>{tier === "all" ? (isPinnacleUrlSlug(collectionSlug) ? "All Variants" : "All Rarities") : tier}</option> })}
      </select>
      {/* No lock filter where the collection has no locking (Disney Pinnacle). */}
      {collectionHasLocking(collectionSlug) && (
      <select aria-label="Filter by lock state" value={view.lockedFilter} onChange={function(e) { dispatchView({ type: "SET", field: "lockedFilter", value: e.target.value }) }} className="rpc-filter-select">
        <option value="all">All Lock States</option>
        <option value="locked">Locked</option>
        <option value="unlocked">Unlocked</option>
      </select>
      )}
      <input aria-label={isPinnacleUrlSlug(collectionSlug) ? "Filter pins" : "Filter moments"} value={view.searchWithin} onChange={function(e) { dispatchView({ type: "SET", field: "searchWithin", value: e.target.value }) }} placeholder={isPinnacleUrlSlug(collectionSlug) ? "Filter pins…" : "Filter moments…"} className="rpc-filter-input col-span-2 sm:col-span-1" />
      <LeagueFilter value={view.leagueFilter} onChange={function(v) { dispatchView({ type: "SET", field: "leagueFilter", value: v }) }} visible={collectionSlug === "nba-top-shot"} />
    </div>
  )
}
