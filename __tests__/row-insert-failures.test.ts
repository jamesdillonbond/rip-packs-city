import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  isTransientDbError,
  newRowInsertFailureTally,
  recordRowInsertFailure,
  rowInsertFailureExtra,
} from "@/lib/pipeline/row-insert-failures"

// lib/pipeline/row-insert-failures — keeps a forward sales indexer's row-retry
// outcomes apart. Before 2026-10-09 every failed row counted as a duplicate (or
// as nothing), the cursor advanced past it and the run said ok:true.

describe("recordRowInsertFailure", () => {
  it("only a 23505 is a duplicate", () => {
    const t = newRowInsertFailureTally()
    expect(recordRowInsertFailure(t, { code: "23505", message: "duplicate key" })).toBe("duplicate")
    expect(t).toMatchObject({ duplicates: 1, transient: 0, permanent: 0, firstError: null })
  })

  it("a timeout, a connection failure, a saturated server or a thrown error is TRANSIENT", () => {
    const t = newRowInsertFailureTally()
    for (const e of [
      { code: "57014", message: "canceling statement due to statement timeout" },
      { code: "08006", message: "connection failure" },
      { code: "53300", message: "too many connections" },
      { code: "40P01", message: "deadlock detected" },
      { code: "PGRST002", message: "schema cache" },
      new Error("fetch failed"),
    ]) {
      expect(recordRowInsertFailure(t, e)).toBe("transient")
    }
    expect(t.transient).toBe(6)
    expect(t.firstError).toBe("57014: canceling statement due to statement timeout")
  })

  it("a CHECK / type / FK error is PERMANENT — retrying cannot fix it", () => {
    const t = newRowInsertFailureTally()
    for (const code of ["23514", "22P02", "23503", "23502"]) {
      expect(recordRowInsertFailure(t, { code, message: "bad row" })).toBe("permanent")
    }
    expect(t.permanent).toBe(4)
  })

  it("keeps at most five samples and always reports all three counts", () => {
    const t = newRowInsertFailureTally()
    for (let i = 0; i < 9; i++) recordRowInsertFailure(t, { code: "23514", message: `r${i}` })
    const x = rowInsertFailureExtra(t)
    expect(x.insert_failed_sample).toHaveLength(5)
    expect(x).toMatchObject({ insert_failed_transient: 0, insert_failed_permanent: 9 })
    expect(rowInsertFailureExtra(newRowInsertFailureTally())).toEqual({
      insert_failed_transient: 0,
      insert_failed_permanent: 0,
      insert_failed_sample: [],
    })
  })

  it("isTransientDbError is false for no error at all", () => {
    expect(isTransientDbError(null)).toBe(false)
    expect(isTransientDbError(undefined)).toBe(false)
  })
})

// Source guard: the forward indexers' row-by-row retries must record every
// failed row. The shapes below are the ones that silently dropped sales.
describe("forward sales indexers record every failed row-retry", () => {
  const FILES = [
    "app/api/sales-indexer/route.ts",
    "app/api/allday-sales-indexer/route.ts",
    "app/api/golazos-sales-indexer/route.ts",
  ]
  for (const f of FILES) {
    it(`${f} tallies row failures and holds its cursor on a transient one`, () => {
      const src = readFileSync(f, "utf8")
      expect(src).toContain("recordRowInsertFailure(insertFailures")
      expect(src).toMatch(/insertFailures\.transient > 0/)
      expect(src).toMatch(/insertFailures\.permanent > 0/)
      expect(src).not.toMatch(/if \(singleErr\) duped\+\+/)
      // a retry that only counts successes is the silent-drop shape
      expect(src).not.toMatch(/if \(!se\) rowsWritten\+\+\s*\n\s*\}/)
    })
  }
})
