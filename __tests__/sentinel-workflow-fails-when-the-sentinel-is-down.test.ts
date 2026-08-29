import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { parse } from "yaml"

/**
 * Until 2026-08-29 `.github/workflows/pipeline-sentinel.yml` captured the
 * response's HTTP status into `HTTP_CODE`, echoed it, and NEVER TESTED IT. The
 * only branch that could fail the job was `STATUS = "CRITICAL"`, and a 500, a
 * 504, or a 401 from a rotated token all left `STATUS` as `PARSE_ERROR` — which
 * is not "CRITICAL" — so the step exited 0.
 *
 * A sentinel that was completely DOWN therefore reported GREEN, on the one
 * workflow whose badge is the fleet alarm's only signal to anyone who is not
 * watching Telegram. The route has 504'd under disk-IO saturation before (its
 * own header records the 60 -> 180s maxDuration raise for exactly that), so the
 * green-while-down state was reachable, not hypothetical.
 *
 * ⚠ THIS TEST EXECUTES THE REAL SCRIPT rather than grepping it. A grep for
 * `if [ "$HTTP_CODE" != "200" ]` would pass against a script that tests the code
 * and then swallows the result, and would die on a harmless reformat — the
 * failure mode this repo keeps recording as "a test stating the contract in a
 * comment and asserting something weaker". The contract here is a DECISION —
 * response in, exit code out — so the assertion is that decision, taken by the
 * shipped bash.
 */

const ROOT = join(__dirname, "..")
const WORKFLOW_PATH = join(ROOT, ".github/workflows/pipeline-sentinel.yml")
const WORKFLOW_SRC = readFileSync(WORKFLOW_PATH, "utf8")

function sentinelStep(): { run: string; timeoutMinutes: number } {
  const doc = parse(WORKFLOW_SRC) as any
  const job = doc.jobs.sentinel
  const steps = job.steps as Array<{ name?: string; run?: string }>
  const step = steps.find((s) => typeof s.run === "string" && s.run.includes("/api/sentinel"))
  if (!step?.run) throw new Error("no step in pipeline-sentinel.yml calls /api/sentinel")
  return { run: step.run, timeoutMinutes: Number(job["timeout-minutes"]) }
}

/**
 * Make the shipped script runnable off-CI with exactly three substitutions, each
 * asserted by OCCURRENCE COUNT so a silent no-op replace cannot hand back a
 * "result" measured against a script that was never transformed:
 *   1. the GitHub `${{ secrets.… }}` expression is replaced with a literal.
 *      ⚠ It is NOT inert text to bash — `${{` is a bad substitution, so the
 *      whole `RESPONSE=$(curl …)` fails, `|| RESPONSE=""` swallows it, and every
 *      fixture arrives EMPTY. Left in, this harness reports "unreachable" for
 *      every case including the healthy ones, which reads as the guard working.
 *      GitHub interpolates before bash ever sees it, so CI is unaffected.
 *   2. the `curl` invocation is shadowed by a function emitting the fixture
 *   3. the retry backoff is zeroed, so a 3-attempt failure case does not spend
 *      30 real seconds inside a 30s testTimeout
 */
function runScript(fixture: string): { code: number; out: string } {
  const { run: shipped } = sentinelStep()

  const ghExprs = shipped.match(/\$\{\{[^}]*\}\}/g) ?? []
  expect(ghExprs.length, "expected exactly one GitHub expression to neutralise").toBe(1)
  const run = shipped.replace(/\$\{\{[^}]*\}\}/g, "harness-token")
  expect(run, "GitHub-expression substitution must have changed the script").not.toBe(shipped)

  const sleeps = run.match(/^\s*sleep \d+$/gm) ?? []
  expect(sleeps.length, "expected exactly one backoff sleep to neutralise").toBe(1)
  const noSleep = run.replace(/^(\s*)sleep \d+$/m, "$1sleep 0")
  expect(noSleep, "sleep substitution must have changed the script").not.toBe(run)

  const curlCalls = noSleep.match(/\bcurl\b/g) ?? []
  expect(curlCalls.length, "expected exactly one curl invocation to shadow").toBe(1)

  const harness = `curl () { printf '%s' "$FIXTURE"; }\n${noSleep}`

  try {
    const out = execFileSync("bash", ["-e", "-c", harness], {
      env: { ...process.env, FIXTURE: fixture },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { code: 0, out }
  } catch (e: any) {
    return { code: e.status ?? -1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }
  }
}

const body = (b: string, code: string) => `${b}\n${code}`

describe("pipeline-sentinel.yml fails when the sentinel is down", () => {
  it("passes only when the sentinel answered 200 with a readable non-CRITICAL status", () => {
    expect(runScript(body('{"status":"ALL CLEAR"}', "200")).code).toBe(0)
    expect(runScript(body('{"status":"WARN"}', "200")).code).toBe(0)
  })

  it("still fails on CRITICAL — the behaviour that already worked is not lost", () => {
    // Negative control for the change: widening the failure set must not have
    // been achieved by rewriting the branch that was already correct.
    const r = runScript(body('{"status":"CRITICAL"}', "200"))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/CRITICAL/)
  })

  it.each([
    ["500 with an HTML error page", "<html>Server Error</html>", "500"],
    ["504 gateway timeout with an empty body", "", "504"],
    ["401 from a rotated INGEST_SECRET_TOKEN", '{"error":"Unauthorized"}', "401"],
  ])("fails when the sentinel is unreachable: %s", (_label, b, code) => {
    // Each of these three exited 0 before 2026-08-29.
    const r = runScript(body(b, code))
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/unreachable/i)
  })

  it("fails on a 200 whose body cannot be read as a status", () => {
    // A 200 carrying HTML is the shape the route's own header records reaching
    // this parser. "Unreadable" must not resolve to "not CRITICAL".
    const html = runScript(body("<html>oops</html>", "200"))
    expect(html.code).toBe(1)
    expect(html.out).toMatch(/unreadable/i)

    const noKey = runScript(body('{"checks":[]}', "200"))
    expect(noKey.code).toBe(1)
    expect(noKey.out).toMatch(/unreadable/i)
  })

  it("gives the retry loop more wall-clock than the job timeout allows it to spend", () => {
    // A job killed mid-retry is red for the WRONG reason, which is a false alarm
    // on the one workflow that has to stay trustworthy. Derived from the script
    // itself rather than hardcoded, so changing the budget cannot silently
    // outgrow the timeout.
    const { run, timeoutMinutes } = sentinelStep()
    const maxTime = Number(run.match(/--max-time (\d+)/)?.[1])
    const backoff = Number(run.match(/^\s*sleep (\d+)$/m)?.[1])
    const attempts = (run.match(/for attempt in ([\d ]+); do/)?.[1] ?? "").trim().split(/\s+/).length

    expect(Number.isFinite(maxTime)).toBe(true)
    expect(Number.isFinite(backoff)).toBe(true)
    expect(attempts).toBeGreaterThan(1)

    const worstCaseSeconds = attempts * maxTime + (attempts - 1) * backoff
    expect(timeoutMinutes * 60).toBeGreaterThan(worstCaseSeconds)
  })

  it("waits at least as long as the route's own maxDuration before calling it unreachable", () => {
    // curl must not cut off a run the platform would have finished: a timeout
    // shorter than the lambda's own budget manufactures the very "unreachable"
    // it now fails on.
    const { run } = sentinelStep()
    const maxTime = Number(run.match(/--max-time (\d+)/)?.[1])
    const routeSrc = readFileSync(join(ROOT, "app/api/sentinel/route.ts"), "utf8")
    const routeMax = Number(routeSrc.match(/export const maxDuration = (\d+)/)?.[1])

    expect(Number.isFinite(routeMax)).toBe(true)
    expect(maxTime).toBeGreaterThanOrEqual(routeMax)
  })
})
