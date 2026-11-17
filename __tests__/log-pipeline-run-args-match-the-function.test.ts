// __tests__/log-pipeline-run-args-match-the-function.test.ts
//
// Every `log_pipeline_run` call in this repo is wrapped in a deliberately
// NON-FATAL try/catch — telemetry must never break the work it measures. The
// cost of that (correct) choice is that a call which PostgREST rejects fails
// SILENTLY: the pipeline keeps working and simply never appears in
// `pipeline_runs`, which is indistinguishable from "it was never invoked".
//
// That is not hypothetical. `/api/cron/stale-fmv-monitor` passed `p_duration_ms`
// — not a parameter of the function, and `duration_ms` is a GENERATED column
// that cannot be written at all. PostgREST resolves an overload by its
// argument-NAME set, so the call matched nothing and threw on every run. It was
// the file's only call site, so that monitor had written ZERO rows ever while
// running on schedule via ops-monitor.yml.
//
// The parameter list below is the live signature, verified against pg_proc:
//   log_pipeline_run(text, timestamptz, integer, integer, integer, boolean,
//                    text, text, text, text, jsonb)
// There is also a 3-arg convenience overload, log_pipeline_run(text, boolean,
// jsonb), which some callers use.
//
// ⚠ METHOD NOTE, because getting this wrong wasted a pass: a naive scan for
// `p_[a-z_]+:` inside the call block reports many false positives, because
// `p_extra: { ... }` nests arbitrary keys and several of those are themselves
// snake_case. The parser here tracks brace/bracket depth and reads keys at
// DEPTH 1 ONLY. When this guard and a live measurement disagree, believe the
// measurement — that contradiction is what exposed the bad parser.

import { describe, expect, it } from "vitest"
import { readFileSync } from "fs"
import { filesMatching } from "./helpers/source-files"

/** Live signature of the 11-arg overload (pg_proc, 2026-08-15). */
const VALID_ARGS = new Set([
  "p_pipeline",
  "p_started_at",
  "p_rows_found",
  "p_rows_written",
  "p_rows_skipped",
  "p_ok",
  "p_error",
  "p_collection_slug",
  "p_cursor_before",
  "p_cursor_after",
  "p_extra",
])

interface CallSite {
  file: string
  args: string[]
}

/** Top-level keys of every `.rpc("log_pipeline_run", { ... })` argument object. */
function callSites(): CallSite[] {
  // ⚠ WAS a shelled-out grep. It happened to work on Windows, which is the
  // trap rather than the reprieve: the mechanism holds only until someone
  // widens the pattern to one containing a space, at which point it dies — or,
  // via `|| true`, returns nothing and the guard passes having read no files.
  // Population unchanged across the migration: 98 files.
  const files = filesMatching("app", (n) => n === "route.ts", "log_pipeline_run")
    .join("\n")
    .trim()
    .split("\n")
    .filter(Boolean)

  const out: CallSite[] = []
  for (const file of files) {
    const src = readFileSync(file, "utf8")
    const re = /rpc\(\s*["']log_pipeline_run["']\s*,\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const open = m.index + m[0].length - 1
      let depth = 0
      const args: string[] = []
      for (let k = open; k < src.length; k++) {
        const c = src[k]
        if (c === "{" || c === "[") depth++
        else if (c === "}" || c === "]") {
          depth--
          if (depth === 0) break
        } else if (depth === 1) {
          const prev = src[k - 1]
          if (prev === "{" || prev === "," || prev === "\n" || prev === " " || prev === "\t") {
            const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(src.slice(k))
            if (km) args.push(km[1])
          }
        }
      }
      out.push({ file, args })
    }
  }
  return out
}

describe("log_pipeline_run call sites match the deployed function signature", () => {
  const sites = callSites()

  it("finds the call sites (not vacuous)", () => {
    expect(sites.length).toBeGreaterThan(50)
    expect(sites.some((s) => s.file.includes("stale-fmv-monitor"))).toBe(true)
  })

  it("passes no argument the function does not accept", () => {
    const offenders = sites
      .map((s) => ({ file: s.file, bad: s.args.filter((a) => a.startsWith("p_") && !VALID_ARGS.has(a)) }))
      .filter((s) => s.bad.length > 0)

    expect(
      offenders,
      `These calls pass parameters log_pipeline_run does not have. PostgREST resolves ` +
        `overloads by argument NAME, so the call matches nothing and throws — and every ` +
        `call site swallows that in a non-fatal catch, so the pipeline silently stops ` +
        `logging:\n` +
        offenders.map((o) => `  ${o.file}: ${o.bad.join(", ")}`).join("\n")
    ).toEqual([])
  })

  it("every call identifies its pipeline", () => {
    for (const s of sites) {
      expect(s.args, `${s.file}: a log call with no p_pipeline`).toContain("p_pipeline")
    }
  })

  it("⚠ never writes duration_ms — it is a GENERATED column", () => {
    // duration_ms = GREATEST(0, epoch(finished_at - started_at) * 1000). Passing
    // it is always a mistake; the way to get a real duration is p_started_at.
    for (const s of sites) {
      expect(s.args, `${s.file}: duration_ms cannot be written`).not.toContain("p_duration_ms")
    }
  })

  it("the parser reads depth-1 keys only", () => {
    // Guards the guard: p_extra nests snake_case keys, and counting those was a
    // false-positive factory that briefly reported 9 broken pipelines that were
    // in fact logging normally.
    const withExtra = sites.filter((s) => s.args.includes("p_extra"))
    expect(withExtra.length).toBeGreaterThan(10)
    for (const s of withExtra) {
      for (const a of s.args) expect(VALID_ARGS.has(a) || !a.startsWith("p_")).toBe(true)
    }
  })
})
