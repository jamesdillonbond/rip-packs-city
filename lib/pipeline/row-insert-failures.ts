// lib/pipeline/row-insert-failures.ts
//
// The row-by-row retry a forward sales indexer runs after a failed batch insert
// used to count EVERY failed row as a duplicate (`if (singleErr) duped++`), or
// not count it at all (`if (!se) rowsWritten++`). The cursor then advanced past
// the block, and nothing re-reads a block below a forward cursor, so a sale that
// failed on a statement timeout, a saturated pool or a missing partition was
// lost for good, while the run logged ok:true. (Write-side audit, 2026-10-09.)
//
// This tally keeps the three outcomes apart:
//   - 23505 (unique violation) — a genuine duplicate, already recorded;
//   - a TRANSIENT failure (timeout, connection, resources, serialization, or a
//     thrown/no-code error) — a retry can fix it, so the caller HOLDS its cursor
//     and the next tick re-reads the range (dupes then 23505-skip: idempotent);
//   - a NON-TRANSIENT failure (a CHECK / type / FK error) — retrying cannot fix
//     it, and holding the cursor on it would stall the whole lane on one poison
//     row. The caller reports the run ok:false with the code and a sample
//     instead of filing the row under "duped".

export interface RowInsertFailureTally {
  duplicates: number
  transient: number
  permanent: number
  firstError: string | null
  sample: Array<{ code: string | null; message: string }>
}

export function newRowInsertFailureTally(): RowInsertFailureTally {
  return { duplicates: 0, transient: 0, permanent: 0, firstError: null, sample: [] }
}

// SQLSTATE classes/codes a retry can clear.
//   08xxx connection · 53xxx insufficient resources · 57014 statement timeout ·
//   57P01/57P02/57P03 admin/crash shutdown, cannot connect now ·
//   40001 serialization failure · 40P01 deadlock · 55P03 lock not available
const TRANSIENT_CODES = new Set(["57014", "57P01", "57P02", "57P03", "40001", "40P01", "55P03"])

export function isTransientDbError(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  const code = typeof err.code === "string" ? err.code : ""
  if (!code) return true // a thrown fetch/network error, or a PostgREST error with no SQLSTATE
  if (TRANSIENT_CODES.has(code)) return true
  if (code.startsWith("08") || code.startsWith("53")) return true
  // PostgREST's own gateway/timeouts (e.g. PGRST002 schema-cache reload)
  if (code.startsWith("PGRST")) return true
  return false
}

/** Record one failed row insert. `err` is the supabase-js error, or what was thrown. */
export function recordRowInsertFailure(
  tally: RowInsertFailureTally,
  err: unknown,
): "duplicate" | "transient" | "permanent" {
  const e = (err && typeof err === "object" ? err : { message: String(err) }) as {
    code?: string | null
    message?: string | null
  }
  const code = typeof e.code === "string" ? e.code : null
  if (code === "23505") {
    tally.duplicates++
    return "duplicate"
  }
  const message = String(e.message ?? "unknown insert error").slice(0, 200)
  if (tally.firstError == null) tally.firstError = code ? `${code}: ${message}` : message
  if (tally.sample.length < 5) tally.sample.push({ code, message })
  if (isTransientDbError(e)) {
    tally.transient++
    return "transient"
  }
  tally.permanent++
  return "permanent"
}

/** Fields for pipeline_runs.extra — always present, so a 0 is a measured 0. */
export function rowInsertFailureExtra(t: RowInsertFailureTally) {
  return {
    insert_failed_transient: t.transient,
    insert_failed_permanent: t.permanent,
    insert_failed_sample: t.sample,
  }
}
