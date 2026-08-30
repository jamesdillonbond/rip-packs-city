import { describe, it, expect, vi } from "vitest"
import { buildTerminalRunArgs, logTerminalRun } from "../lib/pipeline/terminal-run"

// The contract this helper exists to hold in ONE place, because the last time it
// was left to call sites five routes hand-rolled it and no two agreed. The
// divergence that mattered was `rows_* = 0` — a measurement nobody took, which
// made a live pipeline look inert in the 2026-08-16 retirement sweep.

describe("buildTerminalRunArgs", () => {
  it("defaults every counter to NULL, never 0", () => {
    // ⚠ The single most important assertion here. `0` is a measured zero to
    // every reader and every rollup; `null` is "not measured". A route that did
    // not count something must publish the second.
    const args = buildTerminalRunArgs({ pipeline: "p", startedAt: 0, ok: true })
    expect(args.p_rows_found).toBeNull()
    expect(args.p_rows_written).toBeNull()
    expect(args.p_rows_skipped).toBeNull()
  })

  it("passes a GENUINE zero through — the helper must not make a real 0 unsayable", () => {
    // The false-positive control. A route that walked and found none has a fact
    // to report, and defaulting to null must not swallow it.
    const args = buildTerminalRunArgs({ pipeline: "p", startedAt: 0, ok: true, rowsFound: 0 })
    expect(args.p_rows_found).toBe(0)
  })

  it("accepts a Date, an epoch ms, or an ISO string for startedAt", () => {
    const iso = "2026-08-29T12:00:00.000Z"
    const ms = Date.parse(iso)
    expect(buildTerminalRunArgs({ pipeline: "p", startedAt: new Date(ms), ok: true }).p_started_at).toBe(iso)
    expect(buildTerminalRunArgs({ pipeline: "p", startedAt: ms, ok: true }).p_started_at).toBe(iso)
    expect(buildTerminalRunArgs({ pipeline: "p", startedAt: iso, ok: true }).p_started_at).toBe(iso)
  })

  it("carries ok, the error and extra through unchanged", () => {
    const args = buildTerminalRunArgs({
      pipeline: "backfill",
      startedAt: 0,
      ok: false,
      error: "boom",
      extra: { stage: "walk_failed" },
    })
    expect(args.p_pipeline).toBe("backfill")
    expect(args.p_ok).toBe(false)
    expect(args.p_error).toBe("boom")
    expect(args.p_extra).toEqual({ stage: "walk_failed" })
  })
})

describe("logTerminalRun", () => {
  it("reports FALSE on a returned error — supabase-js RESOLVES errors rather than throwing", () => {
    // ⚠ A bare `await` inside a try/catch would report every failed write as a
    // success. The returned `error` is the only evidence there is.
    const db = { rpc: vi.fn().mockResolvedValue({ error: { message: "denied" } }) }
    return expect(logTerminalRun({ pipeline: "p", startedAt: 0, ok: true }, db)).resolves.toBe(false)
  })

  it("reports TRUE when the row lands, and calls log_pipeline_run with the built args", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ error: null }) }
    await expect(logTerminalRun({ pipeline: "p", startedAt: 0, ok: true }, db)).resolves.toBe(true)
    expect(db.rpc).toHaveBeenCalledWith(
      "log_pipeline_run",
      buildTerminalRunArgs({ pipeline: "p", startedAt: 0, ok: true }),
    )
  })

  it("NEVER THROWS when the write throws — telemetry must not take down the pipeline it watches", async () => {
    const db = { rpc: vi.fn().mockRejectedValue(new Error("network")) }
    await expect(logTerminalRun({ pipeline: "p", startedAt: 0, ok: true }, db)).resolves.toBe(false)
  })
})
