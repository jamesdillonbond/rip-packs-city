// lib/ingest/already-recorded.ts
//
// Drop sales a history backfill is about to PARK in `unmapped_sales` that are
// already recorded — in `sales`, or already parked.
//
// WHY (measured 2026-09-28): `unmapped_sales` has no uniqueness beyond its id, so
// the "23505 row-by-row fallback" the backfills rely on never fires there. Two
// leaks followed:
//   * a sale the backfill could not resolve an edition for — but which the
//     forward indexer HAD recorded in `sales` — was parked anyway, and never
//     cleared: `promote_unmapped_sales` only dedupes rows it can first give an
//     edition. 16,373 All Day + 54 Golazos open rows were exact
//     (collection, nft_id, tx) copies of rows in `sales` (closed 2026-09-28,
//     hint `resolved_by = dedupe_already_in_sales_20260928`). Golazos was still
//     adding them: 39 the week of 09-21, 9 more by 09-28.
//   * a re-scanned range parks the same sale again: 64,373 open All Day rows
//     held 62,731 distinct sales.
// The headers of both backfills said "idempotent dedup on transaction_hash"; no
// such step existed. This is it.
//
// ⛔ A FAILED READ THROWS. Returning the rows unfiltered would re-open the leak on
// every hiccup, and returning none would drop sales that genuinely need parking.
// Both backfills catch at the top level and leave the cursor unmoved, so the
// range is re-scanned intact.
//
// ⛔ Scoped by collection_id on both tables: an nft_id is unique only within a
// collection (CLAUDE.md, #142).

type Db = {
  from: (t: string) => {
    select: (cols: string) => {
      eq: (col: string, v: string) => {
        in: (col: string, vs: string[]) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>
      }
    }
  }
}

export type ParkableRow = { nft_id: string; transaction_hash: string | null }

const key = (tx: string | null, nft: string) => `${tx ?? ""}|${nft}`

export async function dropAlreadyRecorded<T extends ParkableRow>(
  db: Db,
  collectionId: string,
  rows: T[],
  chunk = 200,
): Promise<{ fresh: T[]; skipped: number }> {
  const known = new Set<string>()
  const hashes = [...new Set(rows.map((r) => r.transaction_hash).filter((h): h is string => !!h))]
  for (const table of ["sales", "unmapped_sales"] as const) {
    for (let i = 0; i < hashes.length; i += chunk) {
      const batch = hashes.slice(i, i + chunk)
      const { data, error } = await db
        .from(table)
        .select("transaction_hash, nft_id")
        .eq("collection_id", collectionId)
        .in("transaction_hash", batch)
      if (error) throw new Error(`already-recorded check on ${table} failed (batch at ${i}): ${error.message}`)
      for (const r of (data ?? []) as Array<{ transaction_hash: string | null; nft_id: string | null }>) {
        if (r.nft_id != null) known.add(key(r.transaction_hash, String(r.nft_id)))
      }
    }
  }
  const fresh: T[] = []
  for (const r of rows) {
    const k = key(r.transaction_hash, r.nft_id)
    if (known.has(k)) continue
    known.add(k) // a sale repeated WITHIN this scan is parked once
    fresh.push(r)
  }
  return { fresh, skipped: rows.length - fresh.length }
}
