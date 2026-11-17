// PostgREST caps every read at 1000 rows (and CLAMPS an explicit `.limit()`
// above 1000), so a single `.in(column, values)` whose match set exceeds 1000
// rows silently drops the overflow — the exact trap behind the 2026-07-19
// watchlist FMV/floor regression. When `values` is an UNCAPPED list (a whole
// watchlist, a wallet's editions), run the `.in()` in fixed-size slices and
// concatenate so the lookup stays complete no matter how large the list grows.
//
// Best-effort by design: a chunk that errors is logged and skipped, because the
// call sites here treat these enrichment lookups as optional and degrade to
// null — this preserves that behavior while adding the visibility the raw
// `const { data } = await …` (error-dropped) calls lacked.

// 500 keeps each request's URL well under PostgREST's length limit while
// minimizing round-trips (matches the CHUNK constant used by sniper-feed,
// pack-ev, best-offers, and the wallet-search reads).
export const IN_CHUNK_SIZE = 500

type ChunkableClient = { from: (table: string) => any }

/**
 * Run `client.from(table).select(columns).in(column, values)` in slices of
 * `chunkSize`, returning every matched row across all slices.
 *
 * An empty `values` yields `[]` with no query issued. A per-chunk error is
 * logged (console.warn) and that slice is skipped, so a transient failure on
 * one slice degrades to a partial result rather than throwing.
 */
export async function selectInChunks(
  client: ChunkableClient,
  table: string,
  columns: string,
  column: string,
  values: ReadonlyArray<string | number>,
  chunkSize: number = IN_CHUNK_SIZE
): Promise<any[]> {
  const out: any[] = []
  for (let i = 0; i < values.length; i += chunkSize) {
    const slice = values.slice(i, i + chunkSize)
    const { data, error } = await client.from(table).select(columns).in(column, slice)
    if (error) {
      console.warn(`[selectInChunks] ${table}.${column} chunk failed:`, error.message)
      continue
    }
    if (Array.isArray(data)) out.push(...data)
  }
  return out
}
