import { describe, it, expect } from "vitest"
import {
  newChunkTally,
  chunkFailureError,
  chunkFailureExtra,
} from "@/lib/chains/flow/wallet-backfill-helpers"

// The chunk-failure tally is what turns a SILENT wmc-upsert data loss into a
// visible one: a failing chunk doesn't abort the run (partial progress is
// banked), but it's recorded so the caller can set ok:false + a pipeline_runs
// error instead of reporting a clean success while rows were dropped.

describe("newChunkTally", () => {
  it("starts empty", () => {
    expect(newChunkTally()).toEqual({ chunkErrors: 0, chunkRowsLost: 0, firstChunkError: null })
  })
})

describe("chunkFailureError", () => {
  it("returns null when no chunk failed (the healthy path — must NOT redden a clean run)", () => {
    expect(chunkFailureError(newChunkTally())).toBeNull()
  })
  it("summarizes count + rows lost when chunks failed", () => {
    const t = { chunkErrors: 2, chunkRowsLost: 350, firstChunkError: "23505 dup" }
    expect(chunkFailureError(t)).toBe("wmc_upsert_chunk_failures=2 rows_lost=350 first=23505 dup")
  })
  it("omits the first= clause when there's no message", () => {
    expect(chunkFailureError({ chunkErrors: 1, chunkRowsLost: 200, firstChunkError: null })).toBe(
      "wmc_upsert_chunk_failures=1 rows_lost=200",
    )
  })
  it("truncates a long first error to 200 chars", () => {
    const long = "x".repeat(500)
    const out = chunkFailureError({ chunkErrors: 1, chunkRowsLost: 1, firstChunkError: long })!
    expect(out).toContain("first=" + "x".repeat(200))
    expect(out).not.toContain("x".repeat(201))
  })
})

describe("chunkFailureExtra", () => {
  it("spreads the tally fields for logRun extra", () => {
    expect(chunkFailureExtra({ chunkErrors: 3, chunkRowsLost: 12, firstChunkError: "boom" })).toEqual({
      chunk_errors: 3,
      chunk_rows_lost: 12,
      first_chunk_error: "boom",
    })
  })
})
