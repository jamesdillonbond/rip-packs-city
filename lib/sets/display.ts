// Pure filter + sort for the Sets page's set list
// (app/(collections)/[collection]/sets/page.tsx — a ~900-line client monolith
// neither coverage gate measures). Byte-identical to the page's `displaySets`
// useMemo; the page imports this.

export type SetSortKey = "completion" | "cost" | "name"
export type SetFilterKey = "all" | "complete" | "in_progress" | "not_started"

/** Minimal set-progress shape the filter/sort read. */
export interface DisplaySet {
  completionPct: number
  totalMissingCost?: number | null
  setName: string
}

/** Apply the completion filter, then sort by completion (desc), cost (asc,
 * missing cost sorts last), or set name (locale). Returns a new array. */
export function filterAndSortSets<S extends DisplaySet>(
  sets: S[],
  filter: SetFilterKey,
  sortBy: SetSortKey,
): S[] {
  let out = [...sets]

  if (filter === "complete") out = out.filter((s) => s.completionPct === 100)
  else if (filter === "in_progress") out = out.filter((s) => s.completionPct > 0 && s.completionPct < 100)
  else if (filter === "not_started") out = out.filter((s) => s.completionPct === 0)

  out.sort((a, b) => {
    if (sortBy === "completion") return b.completionPct - a.completionPct
    if (sortBy === "cost") {
      const ca = a.totalMissingCost ?? Infinity
      const cb = b.totalMissingCost ?? Infinity
      return ca - cb
    }
    return a.setName.localeCompare(b.setName)
  })

  return out
}
