// lib/supabase-paginate.ts
//
// PostgREST on this project caps every read at 1,000 rows AND silently CLAMPS an
// explicit .limit() above that — `.limit(2000)` returns 1,000 with no error, no
// warning, and no way to tell a full result from a truncated one. That has now
// produced live wrong numbers five separate times (lock-roi, market, sets-db,
// market-pulse's 4x undercount, the Panini squeeze board), so this is the one
// place the workaround lives.
//
// TWO RULES when using this:
//   1. The query MUST carry a deterministic .order(). Postgres gives no stable
//      row order without ORDER BY, so paging an unordered query can silently
//      duplicate rows on one page and drop them from another.
//   2. Check `truncated`. It means maxPages was hit or a page errored — the
//      caller got a partial set and any total computed from it is a LOWER BOUND.

export interface PagedResult<T> {
  rows: T[]
  /** True when the result is known-incomplete (page error, or maxPages hit). */
  truncated: boolean
  error: string | null
}

/**
 * Fetch every row of a query by paging .range(), instead of a .limit() that
 * PostgREST will quietly clamp.
 *
 * @param makeQuery Builds the query for one page. Must apply .order() and .range(from, to).
 */
export async function fetchAllPaged<T>(
  makeQuery: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  opts: { pageSize?: number; maxPages?: number; label?: string } = {},
): Promise<PagedResult<T>> {
  // Never exceed the server cap — a larger pageSize would be clamped, and the
  // short-page termination check below would then fire on a full page.
  const pageSize = Math.min(Math.max(opts.pageSize ?? 1000, 1), 1000)
  const maxPages = Math.max(opts.maxPages ?? 20, 1)
  const rows: T[] = []

  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize
    const { data, error } = await makeQuery(from, from + pageSize - 1)
    if (error) {
      if (opts.label) console.error(`[${opts.label}] page ${page} failed: ${error.message}`)
      return { rows, truncated: true, error: error.message }
    }
    const batch = data ?? []
    rows.push(...batch)
    // A short page is the only reliable end-of-data signal.
    if (batch.length < pageSize) return { rows, truncated: false, error: null }
  }

  if (opts.label) console.error(`[${opts.label}] hit maxPages=${maxPages}; result is partial`)
  return { rows, truncated: true, error: null }
}
