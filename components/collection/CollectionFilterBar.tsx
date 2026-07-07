"use client"

// Presentational filter-select grid for the wallet-collection viewer
// (app/(collections)/[collection]/collection/page.tsx). Behavior-preserving
// extraction — reads/writes the view reducer via {view, dispatchView} and the
// option arrays the page already derives. No data-fetch logic here.
import LeagueFilter from "@/components/filters/LeagueFilter"
import type {
  CollectionViewState,
  CollectionViewAction,
} from "@/lib/collection/view-reducer"

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
      <select value={view.playerFilter} onChange={function(e) { dispatchView({ type: "SET", field: "playerFilter", value: e.target.value }) }} className="rpc-filter-select">
        {availablePlayers.map(function(p) { return <option key={p} value={p}>{p === "all" ? "All Players" : p}</option> })}
      </select>
      <select value={view.setFilter} onChange={function(e) { dispatchView({ type: "SET", field: "setFilter", value: e.target.value }) }} className="rpc-filter-select">
        {availableSets.map(function(s) { return <option key={s} value={s}>{s === "all" ? "All Sets" : s}</option> })}
      </select>
      <select value={view.seriesFilter} onChange={function(e) { dispatchView({ type: "SET", field: "seriesFilter", value: e.target.value }) }} className="rpc-filter-select">
        {availableSeries.map(function(s) { return <option key={s} value={s}>{s === "all" ? "All Series" : s}</option> })}
      </select>
      <select value={view.rarityFilter} onChange={function(e) { dispatchView({ type: "SET", field: "rarityFilter", value: e.target.value }) }} className="rpc-filter-select">
        {availableRarities.map(function(tier) { return <option key={tier} value={tier}>{tier === "all" ? "All Rarities" : tier}</option> })}
      </select>
      <select value={view.lockedFilter} onChange={function(e) { dispatchView({ type: "SET", field: "lockedFilter", value: e.target.value }) }} className="rpc-filter-select">
        <option value="all">All Lock States</option>
        <option value="locked">Locked</option>
        <option value="unlocked">Unlocked</option>
      </select>
      <input value={view.searchWithin} onChange={function(e) { dispatchView({ type: "SET", field: "searchWithin", value: e.target.value }) }} placeholder="Filter moments…" className="rpc-filter-input col-span-2 sm:col-span-1" />
      <LeagueFilter value={view.leagueFilter} onChange={function(v) { dispatchView({ type: "SET", field: "leagueFilter", value: v }) }} visible={collectionSlug === "nba-top-shot"} />
    </div>
  )
}
