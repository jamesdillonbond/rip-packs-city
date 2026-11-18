#!/usr/bin/env node
// scripts/gha-schedule-fallback.mjs — dispatches GitHub's scheduled workflows from Trevor's laptop while
// GitHub is not delivering `schedule` events (2026-11-17).
//
// WHY. After `.github/` was deleted (1:16 AM PT 11-17) and restored (6:22 AM PT), GitHub delivered ZERO
// `schedule` events to this repository — even to a brand-new workflow — while `workflow_dispatch` kept
// working. Disable/enable, cron edits as the owner, the repo-level Actions toggle and a Support ticket did not
// bring them back that day. The GitHub-only lanes (sales-history backfill, Pinnacle owner discovery, UFC Aptos
// ingest, the sentinel, the site alarm, …) were being dispatched by hand.
//
// WHAT. Every run (Task Scheduler, every 5 min — scripts/gha-schedule-fallback-schedule.bat):
//   1. STAND DOWN if GitHub delivered any `schedule` run in the last 90 min (it is working; nothing to do).
//   2. For each workflow under .github/workflows with `schedule:`, find the most recent cron fire time
//      (UTC, the crons' own clock) inside the last LOOKBACK_MIN. If the workflow has no run of ANY event
//      created at or after that fire time, dispatch it with `gh workflow run` — with the inputs that make a
//      dispatched run do what the scheduled run does (INPUTS below).
//   3. Append one JSON line per run to %LOCALAPPDATA%\rpc-gha-fallback\log.jsonl.
// Stateless and idempotent: a hand dispatch, a GitHub-delivered run or an earlier tick of this script all count
// as "ran", so nothing is dispatched twice for one fire time. `gh` is the signed-in CLI on this machine, so no
// credential is stored anywhere new.
//
// ⚠ Dispatched runs carry event `workflow_dispatch`, NOT `schedule`, on purpose: gha-schedule-watchdog and
// schedule-probe.yml keep measuring whether GITHUB delivers schedules, so this script cannot mask the outage.
// schedule-probe.yml is never dispatched for the same reason.
//
// USAGE  node scripts/gha-schedule-fallback.mjs [--dry]      (--dry prints what it would dispatch)

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = "jamesdillonbond/rip-packs-city"
const STAND_DOWN_MIN = 90
const LOOKBACK_MIN = 6 * 60
const SKIP = new Set(["schedule-probe.yml"])

/**
 * Inputs that make a DISPATCHED run behave like the SCHEDULED one. A workflow that branches on
 * `github.event_name == 'schedule'` / `github.event.schedule` needs an entry here, or the fallback would run a
 * different job (ufc-aptos-sales-ingest's `apply` defaults to false — a dry run).
 * `__tests__/gha-schedule-fallback.test.ts` fails if a scheduled workflow branches on the schedule and is
 * missing from this map.
 */
export const INPUTS = {
  "ufc-aptos-sales-ingest.yml": () => ["-f", "apply=true"],
  // badge-sync: the */6 cron is the tag sweep, the 2,8,14,20 cron is the catalog walk (inputs.catalog).
  "badge-sync.yml": (cron) => ["-f", `catalog=${/^45/.test(cron) ? "true" : "false"}`],
  "topshot-offers-history-backfill.yml": () => [
    "-f", "target=missing_fills", "-f", "range=200000", "-f", "start_block=130290659", "-f", "max_iters=200",
  ],
  // ops-monitor: no inputs; a dispatch also runs the daily data-integrity job (read-only, alert-debounced).
  "ops-monitor.yml": () => [],
}

/** Does one cron FIELD match value v? Supports *, *\/n, a, a-b, a-b/n and comma lists. */
export function fieldMatches(field, v) {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/")
    const step = stepStr ? Number(stepStr) : 1
    let lo, hi
    if (range === "*") {
      lo = 0
      hi = 59
    } else if (range.includes("-")) {
      ;[lo, hi] = range.split("-").map(Number)
    } else {
      lo = hi = Number(range)
      if (stepStr) hi = 59
    }
    return v >= lo && v <= hi && (v - lo) % step === 0
  })
}

/** Does the 5-field cron match the UTC minute of date d? (dom/month are only ever * here, but are honoured.) */
export function cronMatches(cron, d) {
  const [mi, h, dom, mon, dow] = cron.trim().split(/\s+/)
  return (
    fieldMatches(mi, d.getUTCMinutes()) &&
    fieldMatches(h, d.getUTCHours()) &&
    fieldMatches(dom, d.getUTCDate()) &&
    fieldMatches(mon, d.getUTCMonth() + 1) &&
    fieldMatches(dow, d.getUTCDay())
  )
}

/** The most recent fire time ≤ now within lookbackMin, or null. */
export function lastFireAt(cron, now, lookbackMin) {
  const t = new Date(now)
  t.setUTCSeconds(0, 0)
  for (let i = 0; i <= lookbackMin; i++) {
    if (cronMatches(cron, t)) return new Date(t)
    t.setUTCMinutes(t.getUTCMinutes() - 1)
  }
  return null
}

/** Crons declared in a workflow file's `schedule:` block. */
export function cronsOf(yaml) {
  return [...yaml.matchAll(/^\s*-\s*cron:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm)].map((m) => m[1].trim())
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function main() {
  const dry = process.argv.includes("--dry")
  const now = new Date()
  const logDir = join(process.env.LOCALAPPDATA || process.env.HOME || ".", "rpc-gha-fallback")
  mkdirSync(logDir, { recursive: true })
  const log = (rec) => {
    const line = JSON.stringify({ at: now.toISOString(), ...rec })
    console.log(line)
    appendFileSync(join(logDir, "log.jsonl"), line + "\n")
  }

  const lastSched = gh(["api", `repos/${REPO}/actions/runs?event=schedule&per_page=1`, "--jq", ".workflow_runs[0].created_at // empty"])
  if (lastSched && now - new Date(lastSched) < STAND_DOWN_MIN * 60_000) {
    log({ verdict: "stand_down", last_schedule_run: lastSched })
    return
  }

  const dir = fileURLToPath(new URL("../.github/workflows/", import.meta.url))
  const dispatched = []
  const failed = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".yml")).sort()) {
    if (SKIP.has(file)) continue
    const crons = cronsOf(readFileSync(join(dir, file), "utf8"))
    if (crons.length === 0) continue
    let due = null
    let dueCron = null
    for (const c of crons) {
      const t = lastFireAt(c, now, LOOKBACK_MIN)
      if (t && (!due || t > due)) {
        due = t
        dueCron = c
      }
    }
    if (!due) continue
    const lastRun = gh(["api", `repos/${REPO}/actions/workflows/${file}/runs?per_page=1`, "--jq", ".workflow_runs[0].created_at // empty"])
    if (lastRun && new Date(lastRun) >= due) continue
    const extra = INPUTS[file] ? INPUTS[file](dueCron) : []
    if (dry) {
      dispatched.push({ file, due: due.toISOString(), inputs: extra, dry: true })
      continue
    }
    try {
      gh(["workflow", "run", file, "--repo", REPO, "--ref", "main", ...extra])
      dispatched.push({ file, due: due.toISOString(), inputs: extra })
    } catch (e) {
      failed.push({ file, error: String(e.stderr || e.message).split("\n")[0].slice(0, 160) })
    }
  }
  log({ verdict: "dispatching", last_schedule_run: lastSched || null, dispatched, failed })
  if (failed.length > 0) process.exitCode = 1
}

// Windows reports the drive as `c:` or `C:` depending on the caller, so compare case-insensitively.
if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase()) main()
