import { describe, it, expect } from "vitest"
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse } from "yaml"

// `.github/workflows/rpc-pipeline.yml` calls six production ingest endpoints
// ~3×/day and, until 2026-08-29, COULD NOT FAIL (register R68): six of six steps
// were `continue-on-error` with non-200 emitting only `::warning::`, so 30 of 30
// recent runs read `success` by construction. Two steps did not even test the
// status they captured, and one captured none.
//
// The fix keeps per-step tolerance — one bad endpoint must not starve the rest —
// and adds a gate that fails when EVERY endpoint failed. These tests pin both
// halves, plus the thing the workflow alone cannot express: that every route it
// calls writes a durable `pipeline_runs` row, so a run's outcome survives past
// GHA log retention.

const WORKFLOW_PATH = ".github/workflows/rpc-pipeline.yml"
const raw = readFileSync(WORKFLOW_PATH, "utf8")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wf: any = parse(raw)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const steps: any[] = wf.jobs.pipeline.steps

/** Steps that call a production endpoint, found by their curl, not by a name list. */
const curlSteps = steps.filter((s) => typeof s.run === "string" && /curl\s/.test(s.run))
const gateStep = steps.find((s) => typeof s.run === "string" && /STATUS_DIR\/\$name/.test(s.run))

/** The route paths this workflow actually calls, read off the URLs. */
const CALLED_ROUTES = [
  ...new Set(
    [...raw.matchAll(/https:\/\/www\.rippackscity\.com(\/api\/[a-z0-9/-]+)/g)].map((m) => m[1]),
  ),
].sort()

describe("the RPC pipeline workflow can fail", () => {
  it("is not vacuous — the walk found the endpoint steps and the gate", () => {
    // ⚠ Every predicate below can pass by finding nothing. A renamed step, a
    // switch away from curl, or a restructured job would otherwise make this
    // whole file green while measuring an empty set.
    expect(curlSteps.length, "no curl steps found — the parser or the job shape changed").toBe(6)
    expect(gateStep, "no gate step found").toBeTruthy()
    expect(CALLED_ROUTES.length, "no production URLs found in the workflow").toBe(6)
  })

  it("keeps every endpoint step tolerant, so one bad endpoint cannot starve the rest", () => {
    // The false-positive control for the gate: making the steps themselves fail
    // would reintroduce the 2026-06-25 starvation this job was restructured to fix.
    expect(curlSteps.map((s) => s["continue-on-error"])).toEqual([true, true, true, true, true, true])
  })

  it("has exactly one step that can fail the job, and it is the gate", () => {
    const canFail = steps.filter((s) => s["continue-on-error"] !== true).map((s) => s.name)
    expect(canFail).toContain(gateStep.name)
    expect(canFail.filter((n: string) => /curl/i.test(n))).toEqual([])
  })

  it("makes every endpoint step RECORD its status, including the two that never tested one", () => {
    // ⚠ Asserted per step rather than as a count. "Backfill Player Names"
    // captured STATUS and never tested it; "Price snapshots" captured no status
    // code at all. Both read as checks to anyone skimming — a latent-green shape.
    for (const s of curlSteps) {
      expect(s.run, `${s.name} does not write a status file`).toMatch(/> "\$STATUS_DIR\//)
      expect(s.run, `${s.name} does not test its status`).toMatch(/if \[ "\$STATUS" != "200" \]/)
      // `bash -e` aborts a step at a failing command in an ASSIGNMENT, which
      // would skip the write below it and leave the gate reading a missing file.
      expect(s.run, `${s.name} does not guard its capture against bash -e`).toMatch(/\) \|\| STATUS=""/)
    }
  })

  it("declares EXPECTED_STEPS equal to the real endpoint count, so the gate's list cannot drift", () => {
    expect(String(wf.jobs.pipeline.env.EXPECTED_STEPS)).toBe(String(curlSteps.length))
  })

  it("gates on the SAME endpoint names the steps write, with no extras and none missing", () => {
    const written = curlSteps
      .map((s) => /> "\$STATUS_DIR\/([a-z-]+)"/.exec(s.run)?.[1])
      .filter(Boolean)
      .sort()
    const gated = (/for name in ([^;]+); do/.exec(gateStep.run)?.[1] ?? "").trim().split(/\s+/).sort()
    expect(gated).toEqual(written)
  })
})

describe("the gate's shell logic, executed", () => {
  // The workflow's own `run:` body, run under bash against fixtures. A YAML
  // assertion cannot tell you whether the script works; this can.
  const script = gateStep.run as string

  function runGate(files: Record<string, string>, expectedSteps = "6") {
    const dir = mkdtempSync(join(tmpdir(), "rpc-gate-"))
    try {
      for (const [name, code] of Object.entries(files)) writeFileSync(join(dir, name), code)
      try {
        const out = execFileSync("bash", ["-e", "-c", script], {
          env: { ...process.env, STATUS_DIR: dir, EXPECTED_STEPS: expectedSteps },
          encoding: "utf8",
        })
        return { code: 0, out }
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const err = e as any
        return { code: err.status as number, out: `${err.stdout ?? ""}${err.stderr ?? ""}` }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const ALL = ["ingest", "fmv-recalc", "fmv-backfill", "backfill-player-names", "backfill", "price-snapshots"]
  const allAt = (code: string) => Object.fromEntries(ALL.map((n) => [n, code]))

  it("passes when every endpoint returned 200", () => {
    expect(runGate(allAt("200")).code).toBe(0)
  })

  it("passes on PARTIAL failure — that is normal here and self-heals on the next tick", () => {
    expect(runGate({ ...allAt("500"), ingest: "200" }).code).toBe(0)
  })

  it("FAILS when every endpoint failed — the outage case that had no signal at all", () => {
    const r = runGate(allAt("500"))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/EVERY endpoint failed/)
  })

  it("FAILS when every step was KILLED and wrote nothing — a missing file is a failure, not an unknown", () => {
    // A step killed by its own timeout-minutes leaves no file. Counting that as
    // "not measured" and passing is the exact shape this change exists to remove.
    const r = runGate({})
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/step wrote nothing/)
  })

  it("FAILS when its list no longer matches EXPECTED_STEPS, rather than reporting a partial population", () => {
    const r = runGate(allAt("200"), "7")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/inspected 6 endpoint\(s\) but EXPECTED_STEPS is 7/)
  })
})

describe("every route this workflow calls writes a durable pipeline_runs row", () => {
  // ⚠ THIS IS THE HALF THE WORKFLOW CANNOT EXPRESS, and it was the bigger one.
  // Four of the six routes wrote no `pipeline_runs` row of any kind, so the run
  // FREQUENCY of four production endpoints was unknowable from any durable
  // store — GHA logs age out, and the badge was green by construction.
  //
  // The population is derived from the workflow's own URLs, so a route added
  // there is covered with no edit here.
  const routeFile = (apiPath: string) => `app${apiPath}/route.ts`
  const handRolled = CALLED_ROUTES.filter((p) => {
    const src = readFileSync(routeFile(p), "utf8")
    return /\.rpc\(\s*"log_pipeline_run"/.test(src)
  })

  it("is not vacuous — every URL in the workflow resolves to a route file", () => {
    for (const p of CALLED_ROUTES) {
      expect(() => readFileSync(routeFile(p), "utf8"), `${routeFile(p)} is unreadable`).not.toThrow()
    }
  })

  it("has no route left writing nothing", () => {
    const silent = CALLED_ROUTES.filter((p) => {
      const src = readFileSync(routeFile(p), "utf8")
      return !/logTerminalRun|log_pipeline_run|writeInvocationHeartbeat/.test(src)
    })
    expect(
      silent,
      `these routes are called ~3x/day and write no pipeline_runs row, so whether they ran is ` +
        `unknowable once the GHA logs age out. Add logTerminalRun() from lib/pipeline/terminal-run.ts ` +
        `on every exit path past auth.`,
    ).toEqual([])
  })

  it("logs under a name derived from its OWN route, not one borrowed from a sub-step", () => {
    // `/api/ingest` logged two SUB-step names (`editions-hydrate-at-insert`,
    // `ingest-canonical-guard`) and never its own outcome, which is how it looked
    // instrumented while `pipeline='ingest'` returned zero rows over 48 h.
    //
    // ⚠ The property, not the spelling: the route must carry its own last path
    // segment as a pipeline name. That holds whether it is written as
    // `const PIPELINE = "…"` or inline as `p_pipeline: "…"`, so converting a
    // route to the helper does not red this.
    const missing = CALLED_ROUTES.filter((p) => {
      const name = p.split("/").pop()!
      return !new RegExp(`(PIPELINE(_NAME)?\\s*[:=]\\s*|p_pipeline:\\s*)"${name}"`).test(
        readFileSync(routeFile(p), "utf8"),
      )
    })
    expect(missing).toEqual([])
  })

  // ⚠ A RATCHET, NOT A BAN — and the difference is a measurement, not a mood.
  // The first draft of this file banned `p_rows_*: 0` outright across these
  // routes and flagged 13 sites in `fmv-recalc`. Opening all 13: TWELVE are on
  // paths that genuinely counted none (an empty sweep window, a delete that
  // wrote nothing, a Step-1a failure before any work), and exactly ONE was the
  // fabrication — the `fatal_after_throw` row, where the run aborted at an
  // UNKNOWN point and 0 claimed a measurement nobody took. That one is fixed;
  // banning the other twelve would have punished accurate code.
  //
  // So what is ratcheted is the STRUCTURAL cause instead: a route that hand-rolls
  // the RPC re-decides the counter contract every time, and the helper defaults
  // them to NULL so it cannot.
  const HAND_ROLLED_BUDGET = 1

  it(`has at most ${HAND_ROLLED_BUDGET} route still hand-rolling log_pipeline_run`, () => {
    expect(
      handRolled,
      `these routes call log_pipeline_run directly instead of logTerminalRun(), so each one ` +
        `re-decides whether an unmeasured counter is 0 or NULL. Convert one and LOWER the budget ` +
        `in the same commit:\n  ${handRolled.join("\n  ")}`,
    ).toHaveLength(HAND_ROLLED_BUDGET)
  })

  it("pins the one fabrication that was found, so it cannot come back", () => {
    // The property, not the line: the fatal path must not publish counters.
    const src = readFileSync("app/api/fmv-recalc/route.ts", "utf8")
    const fatal = src.slice(src.indexOf("[FMV-RECALC] Fatal error:"))
    const block = fatal.slice(0, fatal.indexOf("fatal_after_throw"))
    expect(block).toMatch(/p_rows_found: null/)
    expect(block).not.toMatch(/p_rows_(found|written|skipped): 0/)
  })
})
