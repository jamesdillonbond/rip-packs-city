import { describe, it, expect } from "vitest"
import { readFileSync, mkdtempSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execFileSync } from "node:child_process"
import { parse } from "yaml"

/**
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * On 2026-09-10 the Vercel project was PAUSED at ~14:00Z and the site was down
 * for ~9.5 hours before anyone noticed (register #76). `Pipeline Sentinel`
 * DETECTED it — the workflow went red at 14:34, 18:37 and 21:46 — but the
 * detection left NO durable record anywhere a query could find it, because the
 * only writer of a `pipeline_runs` row for this lane is `log_pipeline_run` at
 * the bottom of `app/api/sentinel/route.ts`, and a 503 never reaches it.
 *
 * 🚨 That is the honesty canon applied to an instrument: A FAILED READ RENDERED
 * AS AN ABSENCE. In `pipeline_runs` the outage read as "pipeline `sentinel`
 * silent for 813 minutes" — character-for-character what a tick GitHub simply
 * never fired looks like, and GitHub sheds ticks on this repo constantly (17
 * `sentinel` rows exist for 09-07 20:44Z → 09-10 09:57Z against 24/day asked
 * for). The one state that mattered was indistinguishable from the state that
 * happens several times a day.
 *
 * The workflow now writes a `sentinel-heartbeat` row BEFORE the call and, on
 * unreachability only, a `sentinel` row with `ok = false` from the runner. THREE
 * states, which is the contract this file pins:
 *
 *   heartbeat + `sentinel` row     -> the tick fired and the route answered
 *   heartbeat, NO `sentinel` row   -> the tick fired and the route DID NOT
 *   no heartbeat at all            -> the tick never happened (shed / disabled)
 *
 * ⚠ EVERY CASE HERE EXECUTES THE SHIPPED `run:` BODY. Grepping the YAML would
 * pass against a step that computes the right values and then forwards the wrong
 * ones, and would die on a harmless reformat — this repo's recorded worst test
 * smell is "a test stating the contract in a comment and asserting something
 * weaker". The contracts below are decisions (response in, row out), so the
 * assertions are those decisions, taken by the shipped bash.
 */

const ROOT = join(__dirname, "..")
const WORKFLOW_SRC = readFileSync(join(ROOT, ".github/workflows/pipeline-sentinel.yml"), "utf8")

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> }

function steps(): Step[] {
  return (parse(WORKFLOW_SRC) as any).jobs.sentinel.steps as Step[]
}

function stepByName(name: string): Step {
  const s = steps().find((x) => x.name === name)
  if (!s?.run) throw new Error(`no step named ${JSON.stringify(name)} with a run: body`)
  return s
}

/** Run a shipped `run:` body under bash -e with `curl` shadowed. */
function runStep(
  step: Step,
  opts: { env?: Record<string, string>; curlStdout?: string; capturePayload?: boolean } = {},
): { code: number; out: string; ghOutput: string; payload: string | null } {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-wf-"))
  const ghOutputPath = join(dir, "gh-output")
  const capturePath = join(dir, "payload")

  // The shadow records the `-d` argument (the row we would have written) and
  // replays a caller-chosen HTTP status, so both the payload and the failure
  // handling are exercised by the real script rather than described by the test.
  const shadow = [
    `curl () {`,
    `  while [ $# -gt 0 ]; do`,
    `    if [ "$1" = "-d" ]; then printf '%s' "$2" > "${capturePath}"; fi`,
    `    shift`,
    `  done`,
    `  printf '%s' "$CURL_STDOUT"`,
    `}`,
  ].join("\n")

  const script = `${shadow}\n${step.run}`
  const env = {
    ...process.env,
    GITHUB_OUTPUT: ghOutputPath,
    CURL_STDOUT: opts.curlStdout ?? "\n200",
    ...(opts.env ?? {}),
  } as NodeJS.ProcessEnv

  let code = 0
  let out = ""
  try {
    out = execFileSync("bash", ["-e", "-c", script], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (e: any) {
    code = e.status ?? -1
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`
  }

  return {
    code,
    out,
    ghOutput: existsSync(ghOutputPath) ? readFileSync(ghOutputPath, "utf8") : "",
    payload: existsSync(capturePath) ? readFileSync(capturePath, "utf8") : null,
  }
}

const response = (body: string, code: string) => `${body}\n${code}`

/** The sentinel step needs its GitHub expression neutralised and its backoff zeroed. */
function runSentinel(fixture: string) {
  const step = stepByName("Run Pipeline Sentinel")

  const ghExprs = step.run!.match(/\$\{\{[^}]*\}\}/g) ?? []
  expect(ghExprs.length, "expected exactly one GitHub expression to neutralise").toBe(1)
  const run = step.run!.replace(/\$\{\{[^}]*\}\}/g, "harness-token")

  const sleeps = run.match(/^\s*sleep \d+$/gm) ?? []
  expect(sleeps.length, "expected exactly one backoff sleep to neutralise").toBe(1)
  const zeroed = run.replace(/^(\s*)sleep \d+$/m, "$1sleep 0")
  expect(zeroed, "sleep substitution must have changed the script").not.toBe(run)

  return runStep({ ...step, run: zeroed }, { curlStdout: fixture })
}

describe("pipeline-sentinel.yml records that it TRIED, so silence is not ambiguous", () => {
  it("writes the heartbeat BEFORE calling the route, not after", () => {
    // Ordering is the whole mechanism. A heartbeat written after the call proves
    // nothing about a call that hung or 503'd, because it would never be reached.
    const names = steps().map((s) => s.name)
    const heartbeat = names.indexOf("Record the invocation before calling the route")
    const sentinel = steps().findIndex((s) => typeof s.run === "string" && s.run.includes("/api/sentinel"))
    expect(heartbeat).toBeGreaterThanOrEqual(0)
    expect(sentinel).toBeGreaterThanOrEqual(0)
    expect(heartbeat).toBeLessThan(sentinel)
  })

  describe("state 2 — the tick fired and the route did not answer", () => {
    it("publishes the unreachability, the status and a classified marker", () => {
      const r = runSentinel(response('{"error":{"code":"DEPLOYMENT_PAUSED"}}', "503"))
      expect(r.code).toBe(1)
      expect(r.ghOutput).toMatch(/^unreachable=true$/m)
      expect(r.ghOutput).toMatch(/^http_code=503$/m)
      expect(r.ghOutput).toMatch(/^marker=deployment_paused$/m)
    })

    it("still publishes a usable status when curl produced no response at all", () => {
      // Connection reset / DNS failure: `RESPONSE` is empty, so `HTTP_CODE` is
      // empty. An empty `http_code=` would be forwarded into the row as a blank,
      // which reads as "unknown" but is really "not captured".
      const r = runSentinel("")
      expect(r.code).toBe(1)
      expect(r.ghOutput).toMatch(/^unreachable=true$/m)
      expect(r.ghOutput).toMatch(/^http_code=0$/m)
      expect(r.ghOutput).toMatch(/^marker=none$/m)
    })

    it("strips the status to digits, because the last line is not always a status", () => {
      // ⚠ THE STATUS IS PARSED AS `tail -1` OF THE RESPONSE. When a transfer dies
      // before curl's `-w` ever runs — a reset mid-body, a truncated proxy reply —
      // the last line is BODY TEXT, and it lands in `HTTP_CODE` looking exactly
      // like a status. Forwarding it verbatim would put an uncontrolled span of
      // an error page into `pipeline_runs.extra` through the one field that was
      // supposed to be a number.
      const r = runSentinel("Bearer sk-live-SHOULD-NEVER-LEAK\n<html>truncated reply</html>")
      expect(r.code).toBe(1)
      expect(r.ghOutput).toMatch(/^unreachable=true$/m)
      expect(r.ghOutput).toMatch(/^http_code=0$/m)
      expect(r.ghOutput).not.toContain("SHOULD-NEVER-LEAK")
      expect(r.ghOutput).not.toContain("<html>")
    })
    it("forwards ONLY bounded tokens — no span of the response body escapes", () => {
      // A non-200 body comes from a layer this repo does not control, and the
      // route's own header records that `pipeline_runs.extra` is exactly where a
      // live credential should never be discovered. So the classification is a
      // whitelist, and the status is stripped to digits.
      const hostile = 'Bearer sk-live-SHOULD-NEVER-LEAK <html>weird "quotes" and \\ backslashes</html>'
      const r = runSentinel(response(hostile, "500"))
      expect(r.code).toBe(1)
      expect(r.ghOutput).not.toContain("SHOULD-NEVER-LEAK")
      expect(r.ghOutput).not.toContain("Bearer")
      expect(r.ghOutput).toMatch(/^marker=none$/m)
      // Nothing but the three bounded keys reaches the next step.
      const keys = r.ghOutput.trim().split("\n").filter(Boolean).map((l) => l.split("=")[0])
      expect(keys.sort()).toEqual(["http_code", "marker", "unreachable"])
    })

    it("writes a sentinel row that is honest about who observed the failure", () => {
      const r = runStep(stepByName("Record that the route did not answer"), {
        env: {
          SUPABASE_URL: "https://example.supabase.co",
          SUPABASE_KEY: "harness-key",
          RUN_ID: "123",
          RUN_ATTEMPT: "1",
          HTTP_CODE: "503",
          MARKER: "deployment_paused",
        },
      })
      expect(r.code).toBe(0)
      expect(r.payload, "the step must have called curl with a -d payload").not.toBeNull()

      const body = JSON.parse(r.payload!)
      expect(body.p_pipeline).toBe("sentinel")
      expect(body.p_ok).toBe(false)
      // `ok = false` is what the daytime monitor scans for; a row omitting it
      // would be written and still never seen.
      expect(typeof body.p_error).toBe("string")
      expect(body.p_error.length).toBeGreaterThan(0)
      expect(body.p_error).toMatch(/runner/i)
      expect(body.p_error).toMatch(/503/)
      expect(body.p_extra.observed).toBe("route_unreachable")
      expect(body.p_extra.source).toBe("github-actions")
      expect(body.p_extra.http_code).toBe("503")
      expect(body.p_extra.marker).toBe("deployment_paused")

      // rows_* are NULL, never 0. The route writes 0 because it genuinely moves
      // no rows (a MEASURED zero); the runner measured nothing at all.
      expect(body.p_rows_found).toBeNull()
      expect(body.p_rows_written).toBeNull()
      expect(body.p_rows_skipped).toBeNull()
    })

    it("only runs on unreachability, gated on the sentinel step's own output", () => {
      // `failure()` alone would fire on CRITICAL and on an unreadable 200 too —
      // both cases where the route ANSWERED and has already written its real row.
      // A second row from the runner would then overwrite a reading with a guess.
      const step = steps().find((s) => s.name === "Record that the route did not answer")!
      expect(step.if).toContain("steps.sentinel.outputs.unreachable")
      expect(step.if).toContain("'true'")
      const sentinel = steps().find((s) => typeof s.run === "string" && s.run.includes("/api/sentinel"))!
      expect(sentinel.id, "the gate above dereferences steps.sentinel").toBe("sentinel")
    })
  })

  describe("state 1 — the route answered, so the runner must stay out of the way", () => {
    it.each([
      ["a clean run", '{"status":"ALL CLEAR"}', "200"],
      ["a WARN run", '{"status":"WARN"}', "200"],
      ["a CRITICAL run", '{"status":"CRITICAL"}', "200"],
      ["a 200 with an unreadable body", "<html>oops</html>", "200"],
    ])("publishes no unreachability for %s", (_label, body, code) => {
      // Negative control for the whole change: every one of these is the route
      // ANSWERING. If any published `unreachable=true` the runner would write a
      // duplicate, wrong row on a lane that had already reported itself.
      const r = runSentinel(response(body, code))
      expect(r.ghOutput).not.toMatch(/unreachable=true/)
    })

    it("has not lost the exit codes it already got right", () => {
      expect(runSentinel(response('{"status":"ALL CLEAR"}', "200")).code).toBe(0)
      expect(runSentinel(response('{"status":"CRITICAL"}', "200")).code).toBe(1)
      expect(runSentinel(response("<html>oops</html>", "200")).code).toBe(1)
    })
  })

  describe("state 3 — the heartbeat itself", () => {
    const HEARTBEAT_ENV = {
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_KEY: "harness-key",
      RUN_ID: "123",
      RUN_ATTEMPT: "2",
    }

    it("writes a sentinel-heartbeat row whose rows_* are NULL, not zero", () => {
      const r = runStep(stepByName("Record the invocation before calling the route"), { env: HEARTBEAT_ENV })
      expect(r.code).toBe(0)
      expect(r.payload).not.toBeNull()

      const body = JSON.parse(r.payload!)
      // `detect_stalled_pipelines()` correlates `<pipeline>-heartbeat` against
      // `<pipeline>`; a different suffix silently opts out of that classifier.
      expect(body.p_pipeline).toBe("sentinel-heartbeat")
      expect(body.p_ok).toBe(true)
      expect(body.p_rows_found).toBeNull()
      expect(body.p_rows_written).toBeNull()
      expect(body.p_rows_skipped).toBeNull()
      expect(body.p_extra.source).toBe("github-actions")
      expect(body.p_extra.run_id).toBe("123")
      expect(body.p_started_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    })

    it.each([
      ["credentials are missing", { ...HEARTBEAT_ENV, SUPABASE_URL: "", SUPABASE_KEY: "" }, "\n200"],
      ["Supabase answers 500", HEARTBEAT_ENV, "\n500"],
      ["curl writes nothing at all", HEARTBEAT_ENV, ""],
    ])("never fails the job when %s", (_label, env, curlStdout) => {
      // This is telemetry ABOUT the alarm. If it could red the badge it would be
      // a second false-alarm source on the one workflow that has to stay
      // trustworthy — and it would mask, not reveal, the state it exists to
      // record. It must warn loudly and get out of the way.
      const r = runStep(stepByName("Record the invocation before calling the route"), { env, curlStdout })
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/::warning::/)
    })

    it("says plainly what is lost when it could not write", () => {
      // "A permanently-red or permanently-zero instrument is indistinguishable
      // from a broken one at a glance" — so the warning names the CONSEQUENCE
      // (the three states collapse back to two), not just the HTTP status.
      const r = runStep(stepByName("Record the invocation before calling the route"), {
        env: { SUPABASE_URL: "", SUPABASE_KEY: "" },
      })
      expect(r.out).toMatch(/indistinguishable/i)
    })
  })

  it("both new steps carry the credentials they need", () => {
    // A config gap must surface here, at CI time, rather than at outage time —
    // the steps deliberately exit 0 without credentials, so nothing else would
    // ever say the secrets had gone missing.
    for (const name of ["Record the invocation before calling the route", "Record that the route did not answer"]) {
      const env = stepByName(name).env ?? {}
      expect(Object.values(env).join(" "), name).toContain("secrets.SUPABASE_SERVICE_ROLE_KEY")
      expect(Object.values(env).join(" "), name).toContain("secrets.NEXT_PUBLIC_SUPABASE_URL")
    }
  })
})
