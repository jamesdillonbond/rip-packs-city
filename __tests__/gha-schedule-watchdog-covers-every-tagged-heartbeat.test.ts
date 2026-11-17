import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, mkdtempSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { parse } from "yaml"

/**
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-09-10 GitHub delivered ZERO `schedule` events to this repository from
 * 01:30Z onward — measured against a 7-hour baseline of ~4.3 scheduled runs per
 * hour — while `workflow_dispatch` and push runs succeeded throughout. Ten
 * ingest lanes plus three more workflows went silent, and NOTHING could say so,
 * because every watcher in this estate is itself a GHA `schedule`: the alarm and
 * its subject failed together.
 *
 * The fix is `public.rpc_gha_schedule_watchdog()` on pg_cron — an INDEPENDENT
 * scheduler — reading heartbeat rows that now record WHICH TRIGGER delivered
 * them (`extra.event` = `github.event_name`). Before that field existed, a
 * scheduled tick and a hand-fired dispatch wrote identical rows, which is
 * exactly the distinction the night turned on.
 *
 * ⚠ THE WATCHDOG NAMES ITS LANES BY EQUALITY, NOT `LIKE '%-heartbeat'`, because
 * the wildcard cannot use `pipeline_runs_pipeline_started_idx` and seq-scans the
 * whole table (measured 3,618 buffers vs 11). That buys a 329x cost reduction
 * and takes on a CURATED LIST, which rots. This file is the guard that keeps it
 * honest: it WALKS the workflows for every heartbeat writer that tags an event
 * and fails if the watchdog's list and the tree disagree — in either direction.
 *
 * ⚠ And it asserts the writers BEHAVIOURALLY by executing the shipped `run:`
 * body, not by grepping it. A step that computes the right value and forwards
 * the wrong one would pass a grep; the recorded worst test smell in this repo is
 * "a test stating the contract in a comment and asserting something weaker".
 */

const ROOT = join(__dirname, "..")
const WORKFLOWS = join(ROOT, ".github", "workflows")
const MIGRATIONS = join(ROOT, "supabase", "migrations")

type Step = { name?: string; run?: string; env?: Record<string, string>; "continue-on-error"?: boolean }
type Writer = { workflow: string; job: string; step: Step }

/** Every workflow step that writes a heartbeat row AND tags it with a trigger event. */
function taggedHeartbeatWriters(): Writer[] {
  const out: Writer[] = []
  for (const f of readdirSync(WORKFLOWS).filter((n) => n.endsWith(".yml") || n.endsWith(".yaml"))) {
    let doc: any
    try {
      doc = parse(readFileSync(join(WORKFLOWS, f), "utf8"))
    } catch {
      continue
    }
    for (const [job, j] of Object.entries<any>(doc?.jobs ?? {})) {
      for (const step of (j?.steps ?? []) as Step[]) {
        const run = step.run ?? ""
        if (run.includes("log_pipeline_run") && run.includes('"event":"') && run.includes("-heartbeat")) {
          out.push({ workflow: f, job, step })
        }
      }
    }
  }
  return out
}

/** The `pipeline IN (...)` list inside the shipped watchdog function. */
function watchdogLanes(): string[] {
  const files = readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))
  const defining = files
    .filter((n) => /CREATE OR REPLACE FUNCTION public\.rpc_gha_schedule_watchdog/.test(readFileSync(join(MIGRATIONS, n), "utf8")))
    .sort()
  expect(defining.length, "no migration defines rpc_gha_schedule_watchdog").toBeGreaterThan(0)
  // Latest definition wins, exactly as it does in the database.
  const sql = readFileSync(join(MIGRATIONS, defining[defining.length - 1]), "utf8")
  const m = sql.match(/pr\.pipeline IN \(([^)]*)\)/)
  expect(m, "the watchdog's pipeline IN (...) list was not found").not.toBeNull()
  return [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

/** Run a shipped `run:` body under bash -e with `curl` shadowed, capturing the -d payload. */
function runStep(step: Step, env: Record<string, string>, curlStdout = "\n200") {
  const dir = mkdtempSync(join(tmpdir(), "hb-"))
  const capturePath = join(dir, "payload")
  const shadow = [
    `curl () {`,
    `  while [ $# -gt 0 ]; do`,
    `    if [ "$1" = "-d" ]; then printf '%s' "$2" > "${capturePath}"; fi`,
    `    shift`,
    `  done`,
    `  printf '%s' "$CURL_STDOUT"`,
    `}`,
  ].join("\n")

  let code = 0
  let out = ""
  try {
    out = execFileSync("bash", ["-e", "-c", `${shadow}\n${step.run}`], {
      env: { ...process.env, CURL_STDOUT: curlStdout, ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e: any) {
    code = e.status ?? -1
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`
  }
  return { code, out, payload: existsSync(capturePath) ? readFileSync(capturePath, "utf8") : null }
}

const CREDS = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_KEY: "harness-key", RUN_ID: "1", RUN_ATTEMPT: "1" }

const writers = taggedHeartbeatWriters()
const lanes = watchdogLanes()

describe("rpc_gha_schedule_watchdog's lane list stays in step with the tree", () => {
  it("NOT VACUOUS: the walk finds the writers and the list parses", () => {
    // A guard that inspected nothing would pass every other case here. Both
    // sides must be non-trivial, and the sampling rate argument in the migration
    // depends on there being MORE than one writer.
    expect(writers.length, "no workflow writes an event-tagged heartbeat").toBeGreaterThanOrEqual(2)
    expect(lanes.length).toBeGreaterThanOrEqual(2)
  })

  it("every event-tagged heartbeat in the tree is a lane the watchdog reads", () => {
    // A writer the watchdog does not read contributes nothing: its ticks are
    // invisible to the one instrument that can see a scheduler stall, and the
    // sampling rate silently falls below what the 6-hour threshold assumes.
    const written = writers.map((w) => heartbeatName(w))
    for (const name of written) expect(lanes, `${name} is written but not read`).toContain(name)
  })

  it("every lane the watchdog reads is still written by some workflow", () => {
    // The reverse rot: a retired or renamed workflow leaves a dead name in the
    // list, and a dead name cannot fail — it just quietly stops contributing.
    const written = new Set(writers.map((w) => heartbeatName(w)))
    for (const lane of lanes) expect([...written], `${lane} is read but nothing writes it`).toContain(lane)
  })
})

/** The `p_pipeline` the step actually sends, taken from the executed payload. */
function heartbeatName(w: Writer): string {
  const r = runStep(w.step, CREDS)
  expect(r.payload, `${w.workflow}/${w.step.name} wrote no payload`).not.toBeNull()
  return JSON.parse(r.payload!).p_pipeline
}

describe.each(writers.map((w) => [`${w.workflow} :: ${w.step.name}`, w] as const))(
  "%s tags the trigger that delivered it",
  (_label, w) => {
    it("forwards github.event_name into extra.event", () => {
      const r = runStep(w.step, { ...CREDS, EVENT: "schedule" })
      const body = JSON.parse(r.payload!)
      expect(body.p_extra.event).toBe("schedule")
      // The whole point: the watchdog counts ONLY event = schedule, so a
      // dispatch must be distinguishable rather than merely present.
      const d = JSON.parse(runStep(w.step, { ...CREDS, EVENT: "workflow_dispatch" }).payload!)
      expect(d.p_extra.event).toBe("workflow_dispatch")
    })

    it("reads github.event_name from the step's own env, not from elsewhere", () => {
      const env = Object.values(w.step.env ?? {}).join(" ")
      expect(env, `${w.workflow}/${w.step.name}`).toContain("github.event_name")
    })

    it("never writes a BLANK event — an absent value must not read as a fact", () => {
      // ⚠ THREE STATES. A blank `event` is not "not a schedule": the watchdog
      // filters `event = 'schedule'`, so an empty string would silently count as
      // "no scheduled tick" and could fabricate a stall out of a missing field.
      // `unknown` is the honest third state.
      const body = JSON.parse(runStep(w.step, CREDS).payload!)
      expect(body.p_extra.event).toBe("unknown")
      expect(body.p_extra.event).not.toBe("")
    })

    it("writes rows_* as NULL, never 0 — a heartbeat measured nothing", () => {
      const body = JSON.parse(runStep(w.step, { ...CREDS, EVENT: "schedule" }).payload!)
      expect(body.p_rows_found).toBeNull()
      expect(body.p_rows_written).toBeNull()
      expect(body.p_rows_skipped).toBeNull()
    })

    it("cannot fail its job, whatever the write does", () => {
      // Telemetry about an alarm must never become a second false-alarm source.
      // Either the step swallows failure itself or the workflow marks it
      // continue-on-error; both are acceptable, silence is not.
      const tolerant = w.step["continue-on-error"] === true
      for (const [label, env, stdout] of [
        ["no credentials", { ...CREDS, SUPABASE_URL: "", SUPABASE_KEY: "" }, "\n200"],
        ["Supabase 500", CREDS, "\n500"],
        ["curl wrote nothing", CREDS, ""],
      ] as const) {
        const r = runStep(w.step, env as Record<string, string>, stdout)
        if (!tolerant) expect(r.code, `${label} reddened the job`).toBe(0)
        expect(r.out, `${label} produced no warning`).toMatch(/::warning::|written/)
      }
    })
  },
)
