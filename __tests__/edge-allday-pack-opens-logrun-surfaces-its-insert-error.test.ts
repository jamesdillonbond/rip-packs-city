import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// ── logRun in ingest-allday-pack-opens must SURFACE its own insert error ─────
//
// WHY THIS EXISTS. `logRun` is the ONE writer for both
// `allday-pack-opens-forward` and `allday-pack-opens-backfill`, and it was a
// bare `await supabase.from("pipeline_runs").insert({...})`. supabase-js RETURNS
// errors rather than throwing, so the returned `error` was the only evidence the
// run row had failed to land — and nothing read it. A failed telemetry write was
// therefore indistinguishable from a successful one, and the MISSING ROW reads
// downstream (detect_stalled_pipelines, v_pipeline_failure_rates,
// v_pack_pipeline_health) as "the pipeline did not run" — a louder and different
// claim than "we could not record that it did".
//
// ⚠ THIS IS NOT THE `allday-pack-opens-backfill` SILENCE. The identical call
// writes ~46 forward rows a day, so the writer works; the backfill's cause is
// upstream. The fix and this pin are an independent defect, not that one's
// closure.
//
// ── WHY THE SOURCE IS EXECUTED, NOT RESTATED ────────────────────────────────
// Edge functions are Deno source: CI type-checks them, nothing EXECUTES them,
// and the house options are an inline-copy mirror in `_shared` or a source-text
// pin. Neither can express the load-bearing NEGATIVE here ("a telemetry failure
// does not reach the caller as a throw") — that is a behaviour, and a text pin
// asserting the presence of the word `try` would be exactly the vacuous shape
// CLAUDE.md names: a title carrying a negative claim over an assertion that does
// not keep it. So this extracts `logRun` FROM THE SHIPPED FILE and runs it,
// following __tests__/check-migration-parity-logic.test.ts. A restated copy
// would drift and then assert nothing.
//
// ⚠ Population is ONE synthetic call, deliberately: this pins a contract, not a
// census, so it is satisfiable with zero pipelines defined and cannot punish its
// own success by going vacuous when a pipeline is retired.

const SRC = readFileSync(
  path.resolve(__dirname, "../supabase/functions/ingest-allday-pack-opens/index.ts"),
  "utf8",
)

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

/**
 * The body of `logRun` as it is actually shipped.
 *
 * ⚠ THROWS on a parse miss rather than returning "". An empty body would run
 * clean against every assertion below — a guard that inspected nothing, passing
 * — which is the failure mode this repo has hit repeatedly. A rename must be
 * loud.
 */
function shippedLogRunBody(src: string): string {
  const sig = "async function logRun(pipeline: string"
  const at = src.indexOf(sig)
  if (at < 0) throw new Error("logRun not found in ingest-allday-pack-opens/index.ts — it was renamed or removed")
  const open = src.indexOf("{", src.indexOf(")", at))
  if (open < 0) throw new Error("logRun signature did not parse")
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(open + 1, i)
    }
  }
  throw new Error("logRun body is unbalanced — extraction failed")
}

type Call = { table: string; row: Record<string, unknown> }

/** Build a runnable logRun over a stub client + stub console. */
function makeLogRun(body: string, insert: (row: Record<string, unknown>) => unknown) {
  const inserted: Call[] = []
  const errors: string[] = []
  const supabase = {
    from(table: string) {
      return {
        insert(row: Record<string, unknown>) {
          inserted.push({ table, row })
          return insert(row)
        },
      }
    },
  }
  const stubConsole = {
    error: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
    warn: (...a: unknown[]) => errors.push(a.map(String).join(" ")),
    log: () => {},
  }
  const fn = new AsyncFunction(
    "supabase", "console",
    "pipeline", "startMs", "ok", "found", "written", "cb", "ca", "extra", "error",
    body,
  )
  const call = () =>
    fn(supabase, stubConsole, "allday-pack-opens-backfill", 1_700_000_000_000, true, 3, 3, 100, 90, { t: 1 }, null)
  return { call, inserted, errors }
}

/** A returned PostgREST error — the shape supabase-js hands back, never throws. */
const RETURNED_ERROR = { data: null, error: { message: "PGRST301: JWT expired" } }
const RETURNED_OK = { data: [{ id: 1 }], error: null }

/** The reverted shape, verbatim, for the not-a-no-op proof below. */
const REVERTED_BODY = `
  await supabase.from("pipeline_runs").insert({
    pipeline, started_at: new Date(startMs).toISOString(),
    rows_found: found, rows_written: written, cursor_before: cb != null ? String(cb) : null,
    cursor_after: ca != null ? String(ca) : null, ok, error, extra,
  })
`

describe("ingest-allday-pack-opens logRun — a failed pipeline_runs insert must be surfaced", () => {
  const body = shippedLogRunBody(SRC)

  it("still writes the run row to pipeline_runs (the fix changed handling, not payload)", async () => {
    // Positive control. Without it every assertion below could pass against a
    // logRun that had stopped writing anything at all — "no error logged"
    // and "did not throw" are both true of a function that does nothing.
    // MUTATION CAUGHT: deleting the insert, or renaming the target table.
    const { call, inserted } = makeLogRun(body, () => Promise.resolve(RETURNED_OK))
    await call()
    expect(inserted).toHaveLength(1)
    expect(inserted[0].table).toBe("pipeline_runs")
    expect(inserted[0].row.pipeline).toBe("allday-pack-opens-backfill")
    expect(inserted[0].row.started_at).toBe(new Date(1_700_000_000_000).toISOString())
    // duration_ms is GENERATED (finished_at - started_at) — inserting it errors.
    expect(inserted[0].row).not.toHaveProperty("duration_ms")
  })

  it("surfaces a RETURNED { error } from the insert, naming the pipeline and the cause", async () => {
    // THE CONTRACT. supabase-js resolves — it does not reject — so the returned
    // error is the only evidence. The operator arrives holding the pipeline
    // name, so the log line must carry it as well as the reason.
    // MUTATION CAUGHT: reverting to a bare `await ...insert(...)` (nothing
    // destructured, nothing logged); dropping the `if (logErr)` branch;
    // logging a bare "insert failed" with neither pipeline nor message.
    const { call, errors } = makeLogRun(body, () => Promise.resolve(RETURNED_ERROR))
    await call()
    expect(errors, "a returned insert error was swallowed — the original defect").toHaveLength(1)
    expect(errors[0]).toContain("allday-pack-opens-backfill")
    expect(errors[0]).toContain("PGRST301: JWT expired")
  })

  it("stays SILENT when the insert succeeds", async () => {
    // No-change control, and it is what keeps the assertion above meaningful:
    // an UNCONDITIONAL console.error would satisfy "surfaces the error" while
    // reporting a failure on every healthy run — the permanently-red instrument
    // nobody reads.
    // MUTATION CAUGHT: hoisting the log out of the `if (logErr)` guard.
    const { call, errors } = makeLogRun(body, () => Promise.resolve(RETURNED_OK))
    await call()
    expect(errors).toEqual([])
  })

  it("LOAD-BEARING NEGATIVE: a returned telemetry error does NOT reach the caller as a throw", async () => {
    // These calls sit on the walker's own return paths, including the
    // cursor_read_failed aborts. A throw here would replace a RECORDED failure
    // with an UNRECORDED crash — strictly worse than the defect being fixed —
    // and `after()`/Deno.serve bodies are not wrapped by anything that would
    // catch it.
    // MUTATION CAUGHT: `return Promise.reject(logErr)`; removing the whole
    // handler so the rejection flows out.
    // ⚠ MEASURED, NOT ASSUMED — this test does NOT catch `if (logErr) throw
    // new Error(...)`, the tempting "surface it properly" fix. That throw
    // lands in this function's own catch, so the caller still sees a resolved
    // promise and this test — plus every other one above — still passes. Its
    // real damage is
    // attribution (a RETURNED PostgREST error gets reported as a client
    // blow-up), and that is what the distinguishability test below catches.
    // Do not restate the claim here — it was checked and it is false.
    const { call } = makeLogRun(body, () => Promise.resolve(RETURNED_ERROR))
    await expect(call()).resolves.toBeUndefined()
  })

  it("reports the two failure modes DISTINGUISHABLY — a returned error is not logged as a throw", async () => {
    // supabase-js RETURNING an error and the client THROWING are different
    // faults with different fixes (a PostgREST/permission problem vs
    // transport), and this repo's most expensive defect class is a failure
    // reported as the wrong cause. Collapsing both onto one handler makes the
    // returned-error path — the actual bug being fixed — unfalsifiable in the
    // logs.
    // ⚠ Compares the two lines' LABELS to each other rather than pinning either
    // spelling, so renaming a prefix does not redden this.
    // MUTATION CAUGHT (verified by running it, not assumed): `if (logErr) throw
    // new Error(...)` — that throw lands in this function's own catch, so both
    // paths then emit the catch's label and this flips. Also caught: hoisting
    // one shared console.error out of both branches.
    const returned = makeLogRun(body, () => Promise.resolve(RETURNED_ERROR))
    await returned.call()
    const threw = makeLogRun(body, () => {
      throw new TypeError("fetch failed")
    })
    await threw.call()
    expect(returned.errors).toHaveLength(1)
    expect(threw.errors).toHaveLength(1)
    // The label is the leading `[tag]`; everything after it is the pipeline name
    // and the cause, which the two paths legitimately share.
    const label = (line: string) => line.match(/^\[[^\]]+\]/)?.[0] ?? null
    expect(label(returned.errors[0]), "log lines lost their leading [tag] — this comparison needs one").not.toBeNull()
    expect(label(threw.errors[0])).not.toBeNull()
    expect(
      label(returned.errors[0]),
      "a returned PostgREST error and a client throw are logged under the SAME label — the log cannot tell an operator which fault occurred",
    ).not.toBe(label(threw.errors[0]))
  })

  it("LOAD-BEARING NEGATIVE: a THROWING client does not reach the caller either", async () => {
    // The other half. A returned error is the supabase-js path and the actual
    // bug; a transport/DNS failure genuinely throws, and the contract is the
    // same — telemetry must not be able to take down the pipeline it watches.
    // MUTATION CAUGHT: removing the try/catch while keeping the `if (logErr)`
    // check — that passes every assertion above and fails only this one.
    const { call, errors } = makeLogRun(body, () => {
      throw new TypeError("fetch failed")
    })
    await expect(call()).resolves.toBeUndefined()
    expect(errors.join(" ")).toContain("fetch failed")
  })
})

describe("the pin is not a no-op: the reverted logRun body fails it", () => {
  // Proves the assertions FLIP on the shape that was actually there, rather
  // than passing for some unrelated reason. Without this, "the error is
  // surfaced" is a claim about a body nobody re-checked.
  it("the pre-fix body swallows the returned error (so the contract test would fail)", async () => {
    const { call, errors } = makeLogRun(REVERTED_BODY, () => Promise.resolve(RETURNED_ERROR))
    await call()
    expect(errors, "reverted body must log nothing — otherwise this proof is vacuous").toEqual([])
  })

  it("the pre-fix body DOES propagate a throw (so the negative test would fail)", async () => {
    const { call } = makeLogRun(REVERTED_BODY, () => {
      throw new TypeError("fetch failed")
    })
    await expect(call()).rejects.toThrow("fetch failed")
  })
})
