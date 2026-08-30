#!/usr/bin/env node
/**
 * scripts/clock-sweep.mjs — the wall-clock-dependence detector.
 *
 * WHY THIS EXISTS
 * ---------------
 * Register R67. Three wall-clock-dependent tests landed in ONE day, by three
 * authors, with at least TWO distinct mechanisms:
 *   1. a `getUTCHours() % 6` predicate, so a green-fixture assertion held in
 *      4 hours of 24 — it reddened CI on ANOTHER SESSION'S COMMIT;
 *   2. a block reading real elapsed time;
 *   3. a DATE compared as a DATETIME (`Date.parse("2026-08-30")` is 00:00Z, the
 *      START of the day the price still covers), failing 00:00Z→~13:00Z daily.
 *
 * ⛔ A SOURCE SCAN CANNOT BE THE DETECTOR. `new Date()` appears in hundreds of
 * legitimate fixtures, and a pattern aimed at any one sub-shape misses the other
 * two — sub-shape 3 is not even prevented by clock-pinning discipline. The sound
 * version VARIES THE AMBIENT STATE and compares outcomes, which is this.
 *
 * WHAT IT DOES
 * ------------
 * Runs the suite once per target UTC hour with `RPC_CLOCK_OFFSET_MS` set (the
 * shim lives in `vitest.setup.ts`), then compares the SET of failing tests.
 *
 *   same failing set at every offset  -> nothing clock-dependent (pass)
 *   set differs between offsets       -> the difference IS the finding
 *
 * ⚠ THE CLASSIFICATION IS WHAT MAKES THIS SAFE TO SCHEDULE. R67 filed the
 * `sudo date -s` version and deliberately did NOT ship it, because a
 * clock-shifting job that fails for its OWN reasons is a new permanently-red
 * instrument — its own falsifier was "if it reds for runner reasons rather than
 * test reasons, revert". Shifting inside the test process removes that failure
 * mode by construction: a failure caused by the runner, a bad dependency, or a
 * genuinely broken test fails at EVERY offset, so it is reported as
 * ALWAYS-FAILING and does not trip the sweep. Only a set that CHANGES is a
 * finding. The instrument cannot cry wolf about its own environment.
 *
 * ⚠ NON-VACUITY: every run must report tests, and at least two offsets must
 * actually run. A sweep that compares one empty set to another empty set is
 * indistinguishable from a clean one.
 *
 * Usage:
 *   node scripts/clock-sweep.mjs                       # full suite, default hours
 *   node scripts/clock-sweep.mjs --hours 0,5,13,20
 *   node scripts/clock-sweep.mjs --files __tests__/a.test.ts __tests__/b.test.ts
 */

import { spawnSync } from "node:child_process"
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

/**
 * The UTC hours to sample.
 *
 * ⚠ CHOSEN AGAINST THE KNOWN RESIDUE CLASSES, not spread evenly — an even
 * spread is what a `% 6` predicate survives. `0` is both the notify branch
 * (`hour % 6 === 0`) and the early-UTC window where a date-parsed-as-datetime
 * reads as already elapsed; `5`, `13` and `20` give remainders 5, 1 and 2, so no
 * two agree under mod 6 and no two share a mod-2 or mod-3 parity either.
 */
export const DEFAULT_HOURS = [0, 5, 13, 20]

/** Milliseconds to add to now so the process believes it is at `hour`:30 UTC. */
export function offsetForUtcHour(nowMs, hour) {
  const target = new Date(nowMs)
  target.setUTCHours(hour, 30, 0, 0)
  let delta = target.getTime() - nowMs
  // Always move FORWARD, so the sweep never runs with a clock in the past —
  // an expiry fixture written "tomorrow" would otherwise flip for the wrong
  // reason and read as a finding.
  if (delta < 0) delta += 24 * 60 * 60 * 1000
  return delta
}

/** Failing test ids from a vitest JSON report, as a sorted array. */
export function failingIds(report) {
  const ids = []
  for (const file of report?.testResults ?? []) {
    for (const t of file?.assertionResults ?? []) {
      if (t.status === "failed") ids.push(`${file.name} > ${t.fullName ?? t.title}`)
    }
  }
  return [...new Set(ids)].sort()
}

/** Total tests a report accounted for — the non-vacuity number. */
export function totalTests(report) {
  return (report?.testResults ?? []).reduce((n, f) => n + (f?.assertionResults?.length ?? 0), 0)
}

/**
 * ⚠ THE ONE THING THE IN-PROCESS SHIM CANNOT REACH, found by the sweep's first
 * real run rather than reasoned about in advance.
 *
 * `__tests__/find-future-dated-ledger-headings.test.ts` computes "today in
 * Pacific" in the VITEST process and then runs the detector in a CHILD process
 * via `execFileSync`. A child is a fresh Node with the REAL clock, so under a
 * shifted parent the two disagree and the test fails — at three of four offsets.
 *
 * That difference is an ARTIFACT OF THIS INSTRUMENT, not evidence about the
 * test: in real CI parent and child share one clock and it is not
 * hour-dependent. Reporting it would make the sweep permanently red, which is
 * the exact outcome R67 declined the runner-clock version to avoid.
 *
 * ⛔ It is NOT silently dropped either — a child-process test COULD be genuinely
 * clock-dependent and this cannot tell. It goes in its own bucket, is printed
 * on every run, and says plainly that it is unmeasured rather than clean.
 *
 * The predicate is a PROPERTY of the file, not a name list, so a new test that
 * shells out is covered with no edit here.
 */
export function fileSpawnsChildProcess(src) {
  return /\bnode:child_process\b|\bchild_process\b|\bexecFileSync\b|\bexecSync\b|\bspawnSync\b|\bexecFile\b|\bspawn\b/.test(
    String(src),
  )
}

/** The file part of a `<file> > <test name>` id. */
export function fileOfId(id) {
  const i = String(id).indexOf(" > ")
  return i === -1 ? String(id) : String(id).slice(0, i)
}

/**
 * The decision, pure so it can be pinned without running a suite.
 * `runs` is `[{ hour, failing: string[], total: number }]`.
 * `spawnsChild(file) -> boolean` decides which differences this instrument
 * cannot speak to; the default says "none", so the pure core stays testable.
 *
 * @param {{hour: number, failing: string[], total: number}[]} runs
 * @param {(file: string) => boolean} [spawnsChild]
 */
export function classify(runs, spawnsChild = () => false) {
  const everyRunFails = (id) => runs.every((r) => r.failing.includes(id))
  const anyRunFails = new Set(runs.flatMap((r) => r.failing))

  const alwaysFailing = [...anyRunFails].filter(everyRunFails).sort()
  // The finding: a test whose result DEPENDS on the clock. Failing at some
  // offsets and not others is the only thing that can mean.
  const differing = [...anyRunFails]
    .filter((id) => !everyRunFails(id))
    .map((id) => ({
      id,
      failedAt: runs.filter((r) => r.failing.includes(id)).map((r) => r.hour),
      passedAt: runs.filter((r) => !r.failing.includes(id)).map((r) => r.hour),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))

  const outOfReach = differing.filter((f) => spawnsChild(fileOfId(f.id)))
  const clockDependent = differing.filter((f) => !spawnsChild(fileOfId(f.id)))

  const vacuous = runs.length < 2 || runs.some((r) => r.total === 0)
  return { runs: runs.length, alwaysFailing, clockDependent, outOfReach, vacuous }
}

export function sweepExitCode(result) {
  // ⚠ A sweep that compared one empty set to another empty set would look
  // exactly like a clean one. Fail loudly instead.
  if (result.vacuous) return 2
  return result.clockDependent.length > 0 ? 1 : 0
}

export function renderReport(result) {
  const lines = [
    `clock sweep — ${result.runs} run(s) at different UTC hours`,
  ]
  if (result.alwaysFailing.length > 0) {
    lines.push(
      `  ${result.alwaysFailing.length} test(s) failed at EVERY offset — NOT clock-dependent, ` +
        `so this sweep is not the instrument for them:`,
    )
    for (const id of result.alwaysFailing.slice(0, 10)) lines.push(`    · ${id}`)
  }
  for (const f of result.outOfReach ?? []) {
    lines.push(
      `  UNMEASURED (not a finding, and not a clean bill either) — ${f.id}\n` +
        `    Its file spawns a CHILD PROCESS, which starts with the real clock and does not ` +
        `inherit RPC_CLOCK_OFFSET_MS, so parent and child disagree under this instrument in a way ` +
        `they never do in CI. The difference at hour(s) ${f.failedAt.join(", ")} is an artifact of ` +
        `the sweep. This test's clock-dependence is UNKNOWN, not cleared.`,
    )
  }
  for (const f of result.clockDependent) {
    lines.push(
      `::error::WALL-CLOCK DEPENDENT — ${f.id}\n` +
        `  failed at UTC hour(s) ${f.failedAt.join(", ")} and passed at ${f.passedAt.join(", ")}. ` +
        `The assertion depends on when it ran, so a green run certifies nothing about the other hours ` +
        `— and it will red on someone else's commit. Fix by PINNING the clock (vi.setSystemTime) or by ` +
        `varying it inside the test, not by re-running.`,
    )
  }
  if (result.clockDependent.length === 0 && !result.vacuous) {
    lines.push("  no test changed outcome with the clock.")
  }
  return lines.join("\n")
}

function argList(name) {
  const i = process.argv.indexOf(name)
  if (i === -1) return null
  const out = []
  for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) {
    out.push(process.argv[j])
  }
  return out
}

function runSuiteAt(hour, offsetMs, files, dir) {
  const outFile = join(dir, `report-${hour}.json`)
  const args = ["vitest", "run", "--reporter=json", `--outputFile=${outFile}`, ...files]
  const res = spawnSync("npx", args, {
    env: { ...process.env, RPC_CLOCK_OFFSET_MS: String(offsetMs) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
  if (!existsSync(outFile)) {
    console.error(
      `::error::the vitest run at UTC hour ${hour} produced no JSON report. ` +
        `Exit ${res.status}. This is a HARNESS failure, not a finding — the sweep cannot compare what it did not measure.`,
    )
    console.error((res.stderr ?? "").slice(-4000))
    return null
  }
  const report = JSON.parse(readFileSync(outFile, "utf8"))
  return { hour, failing: failingIds(report), total: totalTests(report) }
}

function main() {
  const hours = (argList("--hours")?.[0] ?? "").trim()
    ? argList("--hours")[0].split(",").map((h) => Number(h.trim()))
    : DEFAULT_HOURS
  const files = argList("--files") ?? []

  const dir = mkdtempSync(join(tmpdir(), "clock-sweep-"))
  try {
    const now = Date.now()
    const runs = []
    for (const hour of hours) {
      const offset = offsetForUtcHour(now, hour)
      process.stdout.write(`running suite as if it were ${String(hour).padStart(2, "0")}:30 UTC … `)
      const run = runSuiteAt(hour, offset, files, dir)
      if (run === null) {
        process.exitCode = 2
        return
      }
      console.log(`${run.total} test(s), ${run.failing.length} failing`)
      runs.push(run)
    }

    const result = classify(runs, (file) => {
      try {
        return fileSpawnsChildProcess(readFileSync(file, "utf8"))
      } catch {
        // ⚠ Unreadable means UNKNOWN, and unknown must not become an exemption:
        // fall back to treating it as in-reach so the finding is still reported.
        return false
      }
    })
    console.log(renderReport(result))
    if (result.vacuous) {
      console.error(
        "::error::the sweep is VACUOUS — fewer than two runs, or a run reported zero tests. " +
          "Comparing one empty set to another is indistinguishable from a clean pass.",
      )
    }
    process.exitCode = sweepExitCode(result)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
