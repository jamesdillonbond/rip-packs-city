import { describe, it, expect } from "vitest"
import {
  collectionViewReducer,
  initialCollectionView,
  type CollectionViewState,
} from "@/lib/collection/view-reducer"

// Wallet-collection viewer view-state reducer. Locks: generic SET, sort-dir
// toggle, SET_SORT with optional direction (keeps prior dir when omitted),
// expanded-row toggle, collapse-all, moment selection, and RESET_FILTERS
// (which clears filters but preserves sort/expanded/selected). Reducer must be
// immutable — original state is never mutated.

describe("collectionViewReducer", () => {
  it("SET updates a single field immutably", () => {
    const next = collectionViewReducer(initialCollectionView, {
      type: "SET",
      field: "playerFilter",
      value: "LeBron James",
    })
    expect(next.playerFilter).toBe("LeBron James")
    expect(initialCollectionView.playerFilter).toBe("all") // original untouched
    expect(next).not.toBe(initialCollectionView)
  })

  it("TOGGLE_SORT_DIR flips desc → asc → desc", () => {
    const asc = collectionViewReducer(initialCollectionView, { type: "TOGGLE_SORT_DIR" })
    expect(asc.sortDirection).toBe("asc")
    const back = collectionViewReducer(asc, { type: "TOGGLE_SORT_DIR" })
    expect(back.sortDirection).toBe("desc")
  })

  it("SET_SORT sets key and defaults direction to the current value when omitted", () => {
    const s: CollectionViewState = { ...initialCollectionView, sortDirection: "asc" }
    const next = collectionViewReducer(s, { type: "SET_SORT", key: "serial" })
    expect(next.sortKey).toBe("serial")
    expect(next.sortDirection).toBe("asc")
  })

  it("SET_SORT honors an explicit direction", () => {
    const next = collectionViewReducer(initialCollectionView, {
      type: "SET_SORT",
      key: "player",
      direction: "asc",
    })
    expect(next.sortKey).toBe("player")
    expect(next.sortDirection).toBe("asc")
  })

  it("TOGGLE_EXPANDED toggles a row on then off", () => {
    const on = collectionViewReducer(initialCollectionView, { type: "TOGGLE_EXPANDED", id: "m1" })
    expect(on.expandedRows.m1).toBe(true)
    const off = collectionViewReducer(on, { type: "TOGGLE_EXPANDED", id: "m1" })
    expect(off.expandedRows.m1).toBe(false)
  })

  it("COLLAPSE_ALL clears expanded rows", () => {
    const on = collectionViewReducer(initialCollectionView, { type: "TOGGLE_EXPANDED", id: "m1" })
    const cleared = collectionViewReducer(on, { type: "COLLAPSE_ALL" })
    expect(cleared.expandedRows).toEqual({})
  })

  it("SELECT_MOMENT sets and clears the selected moment", () => {
    const moment = { momentId: "abc" } as CollectionViewState["selectedMoment"]
    const sel = collectionViewReducer(initialCollectionView, { type: "SELECT_MOMENT", moment })
    expect(sel.selectedMoment).toBe(moment)
    const cleared = collectionViewReducer(sel, { type: "SELECT_MOMENT", moment: null })
    expect(cleared.selectedMoment).toBeNull()
  })

  it("RESET_FILTERS clears filters but preserves sort, expanded rows, and selection", () => {
    let s = collectionViewReducer(initialCollectionView, { type: "SET", field: "playerFilter", value: "X" })
    s = collectionViewReducer(s, { type: "SET", field: "filterListed", value: true })
    s = collectionViewReducer(s, { type: "SET_SORT", key: "serial", direction: "asc" })
    s = collectionViewReducer(s, { type: "TOGGLE_EXPANDED", id: "m1" })

    const reset = collectionViewReducer(s, { type: "RESET_FILTERS" })
    expect(reset.playerFilter).toBe("all")
    expect(reset.filterListed).toBe(false)
    expect(reset.searchWithin).toBe("")
    // preserved
    expect(reset.sortKey).toBe("serial")
    expect(reset.sortDirection).toBe("asc")
    expect(reset.expandedRows.m1).toBe(true)
  })

  it("unknown action returns the same state reference", () => {
    // @ts-expect-error exercising the default branch
    const same = collectionViewReducer(initialCollectionView, { type: "NOPE" })
    expect(same).toBe(initialCollectionView)
  })
})
