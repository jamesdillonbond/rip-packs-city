// Delete-chain recorder for the listing-cache deep suites.
//
// makeInstrumentedSupabaseFixture (route-harness) records insert/upsert/update
// payloads but not .delete() chains — the listing-cache family's core safety
// contract is "upsert first, then conditionally PURGE stale rows with
// .lt('cached_at', <function-top startedAt>)", so those tests need to see (a)
// that a delete fired at all, and (b) the exact filter chain it carried.
// This wraps an already-built fixture's `.from` so that calling `.delete()` on
// a builder starts a recording: every subsequent filter call on that chain
// (.eq/.lt/...) is captured with its args. Purely additive — the underlying
// harness behavior (thenable resolution to the table's fixture payload,
// sequence-aware arrays, failWrites) is untouched.
//
// Keep this file free of `.test.` in its name — it is a helper, not a suite.

export interface RecordedDelete {
  table: string
  filters: Array<{ method: string; args: unknown[] }>
}

const FILTER_METHODS = ["eq", "neq", "lt", "lte", "gt", "gte", "in", "is", "not"] as const

/**
 * Wrap `fixture.from` (from makeSupabaseFixture / makeInstrumentedSupabaseFixture)
 * so delete chains are recorded. Returns the live array of recorded deletes.
 */
export function recordDeletes(fixture: unknown): RecordedDelete[] {
  const deletes: RecordedDelete[] = []
  const f = fixture as { from: (t: string) => Record<string, unknown> }
  const baseFrom = f.from.bind(f)
  f.from = (table: string) => {
    const b = baseFrom(table)
    const baseDelete = b.delete as (...a: unknown[]) => unknown
    b.delete = (...args: unknown[]) => {
      const rec: RecordedDelete = { table, filters: [] }
      deletes.push(rec)
      for (const m of FILTER_METHODS) {
        const orig = b[m] as (...a: unknown[]) => unknown
        b[m] = (...fa: unknown[]) => {
          rec.filters.push({ method: m, args: fa })
          return orig(...fa)
        }
      }
      return baseDelete(...args)
    }
    return b
  }
  return deletes
}

/** Convenience: find a filter entry by method+column, e.g. eq("source", ...). */
export function findFilter(
  rec: RecordedDelete | undefined,
  method: string,
  column: string,
): { method: string; args: unknown[] } | undefined {
  return rec?.filters.find((flt) => flt.method === method && flt.args[0] === column)
}
