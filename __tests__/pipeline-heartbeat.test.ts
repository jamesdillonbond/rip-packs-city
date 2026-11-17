import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  HEARTBEAT_SUFFIX,
  heartbeatPipelineName,
  buildHeartbeatRow,
  writeInvocationHeartbeat,
} from "@/lib/pipeline/heartbeat"

// The contract five routes hand-rolled and no two implemented identically. Each
// case below pins a clause whose divergence was MEASURED live in `pipeline_runs`
// on 2026-08-20, not one imagined for the test:
//
//   * a separate pipeline name  — all five agreed (the hard part)
//   * rows NULL rather than 0   — 1 of 5 (drain-fmv-cold-tail)
//   * duration pinned to 0      — 2 of 5 (the three RPC sites cannot)
//
// ⚠ WHAT THIS FILE CANNOT PROVE, stated so the titles do not over-promise.
// Nothing here detects a `maxDuration` kill; vitest cannot simulate one, and a
// test that claimed to would be the "states the contract in a comment and
// asserts something weaker" shape. What it CAN pin is the property that makes
// the correlation query work at all — the row's shape, and that writing it is
// awaited before the caller proceeds. The kill detection lives in the query
// quoted in the module header.

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

/** Records the row it was handed; `result` decides how the insert answers. */
function makeDb(result: { error: { message: string } | null } | "throw" = { error: null }) {
  const inserted: unknown[] = []
  const tables: string[] = []
  return {
    inserted,
    tables,
    db: {
      from(table: string) {
        tables.push(table)
        return {
          async insert(row: unknown) {
            inserted.push(row)
            if (result === "throw") throw new Error("pool exhausted")
            return result
          },
        }
      },
    },
  }
}

const AT = Date.parse("2026-08-20T12:00:00.000Z")

describe("heartbeatPipelineName — a separate name is the load-bearing part", () => {
  it("appends the suffix to the real pipeline name", () => {
    expect(heartbeatPipelineName("fmv-recalc")).toBe("fmv-recalc-heartbeat")
  })

  it("never returns the bare pipeline name", () => {
    // ⚠ The failure this prevents is the subtle one. These pipelines sit on
    // `pipeline_cadence_watchlist`; a marker under the REAL name refreshes
    // `last_run` every tick, so `detect_stalled_pipelines()` goes quiet on
    // exactly the outage the marker was added to expose. The heartbeat would
    // hide the failure it exists to reveal.
    for (const name of ["fmv-recalc", "candy-offers-indexer", "drain-fmv-cold-tail"]) {
      expect(heartbeatPipelineName(name)).not.toBe(name)
      expect(heartbeatPipelineName(name).endsWith(HEARTBEAT_SUFFIX)).toBe(true)
    }
  })

  it("is idempotent — an already-suffixed name is not double-suffixed", () => {
    // A `foo-heartbeat-heartbeat` row matches no correlation query, so the
    // marker silently stops being readable while still being written.
    expect(heartbeatPipelineName("fmv-recalc-heartbeat")).toBe("fmv-recalc-heartbeat")
  })
})

describe("buildHeartbeatRow — the row shape", () => {
  it("pins finished_at to started_at so duration_ms cannot become the insert latency", () => {
    // ⚠ `duration_ms` is GENERATED ALWAYS AS (finished_at - started_at) and
    // `finished_at` DEFAULTS TO now(). Omitting it published this INSERT's own
    // latency as a run duration — measured live at 42 ms to 56 s across 514
    // rows, and up to 47,462 ms on candy-listings-indexer-heartbeat.
    const row = buildHeartbeatRow({ pipeline: "p", startedAtMs: AT })

    expect(row.started_at).toBe("2026-08-20T12:00:00.000Z")
    expect(row.finished_at).toBe(row.started_at)
  })

  it("leaves every rows_* column NULL — a marker measures nothing", () => {
    // ⚠ The columns DEFAULT to 0, so this is the difference between "no
    // measurement" and "a measurement of zero". The 2026-08-16 retirement sweep
    // read `rows_written = 0` and concluded a live pipeline was inert.
    const row = buildHeartbeatRow({ pipeline: "p", startedAtMs: AT })

    expect(row.rows_found).toBeNull()
    expect(row.rows_written).toBeNull()
    expect(row.rows_skipped).toBeNull()
    // Explicit presence, not just nullish: an OMITTED key takes the column
    // default of 0, which is the very shape being banned. `toBeNull` alone
    // passes on `undefined` under some matchers, so assert the keys exist.
    for (const k of ["rows_found", "rows_written", "rows_skipped"]) {
      expect(Object.prototype.hasOwnProperty.call(row, k), `${k} must be sent explicitly`).toBe(true)
    }
  })

  it("is ok:true so a marker cannot inflate the failure-rate view", () => {
    // An `ok:false` marker would fire alerting for a run that has not failed —
    // it has not finished.
    expect(buildHeartbeatRow({ pipeline: "p", startedAtMs: AT }).ok).toBe(true)
  })

  it("marks the phase so the row is self-describing", () => {
    expect(buildHeartbeatRow({ pipeline: "p", startedAtMs: AT }).extra.phase).toBe("started")
  })

  it("merges caller extra alongside the phase marker", () => {
    const row = buildHeartbeatRow({
      pipeline: "p",
      startedAtMs: AT,
      extra: { offset: 500, edition_limit: 40 },
    })

    expect(row.extra).toEqual({ phase: "started", offset: 500, edition_limit: 40 })
  })

  it("caller extra WINS on a key collision — spread order, stated rather than assumed", () => {
    // ⚠ Pinned because it is the surprising direction and the title of the case
    // above must not be read as promising the opposite. `phase` is spread
    // FIRST, so a caller can override it. That is deliberate — a route with a
    // multi-stage after() may want `phase: "resumed"` — but it means `phase`
    // is a default, not an invariant, and a correlation query keying on
    // `extra->>'phase' = 'started'` would silently miss such a row.
    const row = buildHeartbeatRow({ pipeline: "p", startedAtMs: AT, extra: { phase: "resumed" } })

    expect(row.extra.phase).toBe("resumed")
  })

  it("omits collection_slug and cursor entirely when not supplied", () => {
    // Sending an explicit `undefined` is not the same as omitting: PostgREST
    // rejects unknown-shaped payloads inconsistently, and a null
    // `collection_slug` reads as "all collections" on a per-collection pipeline.
    const row = buildHeartbeatRow({ pipeline: "p", startedAtMs: AT })

    expect(Object.prototype.hasOwnProperty.call(row, "collection_slug")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(row, "cursor_before")).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(row, "cursor_after")).toBe(false)
  })

  it("carries a cursor on both sides, because a marker consumed none of it", () => {
    const row = buildHeartbeatRow({ pipeline: "p", startedAtMs: AT, cursor: "500" })

    expect(row.cursor_before).toBe("500")
    expect(row.cursor_after).toBe("500")
  })

  it("carries a collection slug when the pipeline is scoped", () => {
    const row = buildHeartbeatRow({ pipeline: "p", startedAtMs: AT, collectionSlug: "nba_top_shot" })

    expect(row.collection_slug).toBe("nba_top_shot")
  })
})

describe("writeInvocationHeartbeat — writes to pipeline_runs and never throws", () => {
  it("inserts the built row into pipeline_runs", async () => {
    const { db, inserted, tables } = makeDb()

    const ok = await writeInvocationHeartbeat({ pipeline: "fmv-recalc", startedAtMs: AT }, db)

    expect(ok).toBe(true)
    expect(tables).toEqual(["pipeline_runs"])
    expect(inserted).toEqual([buildHeartbeatRow({ pipeline: "fmv-recalc", startedAtMs: AT })])
  })

  it("writes the table DIRECTLY rather than through log_pipeline_run", async () => {
    // ⚠ Not a style preference. `log_pipeline_run` has NO `p_finished_at`
    // parameter, so an RPC-based heartbeat structurally cannot pin the duration
    // — which is why the three candy call sites publish theirs. Pinning the
    // mechanism keeps a well-meaning "use the RPC like everything else"
    // refactor from silently reintroducing that.
    const rpc = vi.fn()
    const { db, tables } = makeDb()

    await writeInvocationHeartbeat({ pipeline: "p", startedAtMs: AT }, { ...db, rpc })

    expect(rpc).not.toHaveBeenCalled()
    expect(tables).toEqual(["pipeline_runs"])
  })

  it("reports a RETURNED error as a failed write", async () => {
    // ⚠ supabase-js RETURNS errors rather than throwing. A bare `await` inside
    // try/catch would report every failed write as a success — the mechanism
    // behind this repo's most productive defect class.
    const { db } = makeDb({ error: { message: "duplicate key" } })

    expect(await writeInvocationHeartbeat({ pipeline: "p", startedAtMs: AT }, db)).toBe(false)
    expect(logSpy.mock.calls.flat().join(" ")).toContain("duplicate key")
  })

  it("swallows a THROWN error rather than taking the pipeline down with it", async () => {
    // Telemetry must never be able to kill the pipeline it is watching, and an
    // `after()` body is not wrapped by the route's own error handling: an
    // unhandled rejection here loses the real work.
    const { db } = makeDb("throw")

    let result: boolean | undefined
    await expect(
      (async () => {
        result = await writeInvocationHeartbeat({ pipeline: "p", startedAtMs: AT }, db)
      })(),
    ).resolves.toBeUndefined()

    expect(result).toBe(false)
    expect(logSpy.mock.calls.flat().join(" ")).toContain("pool exhausted")
  })

  it("resolves before the caller proceeds — the ordering the correlation depends on", async () => {
    // ⚠ The one property that makes the whole scheme work: a marker written
    // AFTER the work cannot survive the kill it exists to record. Observed
    // directly by interleaving — the insert must have completed before the
    // statement following the await runs.
    const order: string[] = []
    const db = {
      from: () => ({
        async insert() {
          await Promise.resolve()
          order.push("heartbeat")
          return { error: null }
        },
      }),
    }

    await writeInvocationHeartbeat({ pipeline: "p", startedAtMs: AT }, db)
    order.push("work")

    expect(order).toEqual(["heartbeat", "work"])
  })
})
