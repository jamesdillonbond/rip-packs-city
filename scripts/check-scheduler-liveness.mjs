#!/usr/bin/env node
/**
 * scripts/check-scheduler-liveness.mjs
 *
 * WHY THIS EXISTS
 * ---------------
 * GitHub silently DROPS scheduled workflow runs. Measured 2026-08-29 over
 * contiguous pages of run history:
 *
 *   Pipeline Sentinel  (cron  34 * * * *,  24/day)  median gap 1.4h, MAX 12.7h
 *   RPC Ops Monitor    (cron 13,43 * * * *, 48/day) median gap 1.2h, MAX 12.3h
 *   RPC Data Pipeline  (cron 5,25,45 * * *, 72/day) median gap 1.1h, MAX 11.4h
 *
 * On 08-23/24, before the shedding began, the sentinel's max gap was 2.3h.
 *
 * A dropped tick produces NO run, NO badge and NO email, so the failure is
 * invisible to every instrument this repo has: the workflow reads `active`, its
 * last run reads `success`, and nothing anywhere says "the alarm did not fire."
 * That is this repo's own "a permanently-zero instrument is indistinguishable
 * from a broken one", one level up — an instrument that never RUNS is
 * indistinguishable from one that ran and found nothing.
 *
 * WHAT IT CAN AND CANNOT DETECT — read this before trusting it
 * -----------------------------------------------------------
 * ⛔ It does NOT detect the shedding. It CANNOT: at a 12.7h observed max gap,
 *    no silence bound both clears today's steady state and catches an hourly
 *    job that stopped an hour ago. Stating that plainly is the point — the
 *    shedding has already destroyed the ability to detect a stopped scheduler,
 *    and that loss is itself the finding.
 *
 * ✅ It DOES detect TOTAL silence: a workflow GitHub disabled (it does this
 *    after 60 days of repo inactivity), one renamed or deleted out from under
 *    its schedule, a cron expression edited into something that never fires,
 *    and an Actions outage lasting a day. Those are silent today.
 *
 * 📈 It always PRINTS observed-vs-expected per workflow, so the shedding stays
 *    a visible number even though it is not the failure condition. A rate is
 *    reported; only silence is red.
 *
 * 🧪 EXPERIMENT ARMED 2026-09-03 05:56Z (R61's falsifier): allday-ingest.yml,
 *    72 asks/day that produced nothing, was deleted. If the shedding is a
 *    per-REPO budget, the seven remaining high-frequency workflows should
 *    collectively RISE (09-02 window: 7,7,7,6,7,8,6 = 48 observed); if it is a
 *    per-WORKFLOW cap they stay ~5–8 each. The 09-03 report (29% post-deletion)
 *    read 6,7,7,7,7,8,6 = 48 — inconclusive by construction. Read the 09-04
 *    report and later ones; one day is one sample and day-to-day noise
 *    (39 → 48 between 09-01 and 09-02 with nothing changed) is as large as the
 *    effect being looked for.
 *
 * THE BOUND. MAX_SILENT_HOURS is 24 — 1.9x the worst gap ever observed (12.7h).
 * ⚠ It is deliberately loose and it is derived, not chosen: re-measure before
 * tightening it. If the high-frequency crons move off GitHub (the actual fix),
 * the remaining schedules get quiet and this can drop to ~3x nominal period.
 *
 * THE WATCHLIST IS A TREE WALK, NOT A CURATED LIST. It reads every workflow in
 * .github/workflows that declares `on.schedule`, so a newly-added scheduled
 * workflow is covered the day it lands. ⚠ And an unparseable cron is a LOUD
 * config error (exit 2), never a silent skip — a guard that quietly watches
 * nothing is the defect this file exists to catch.
 *
 * Usage:
 *   GITHUB_REPOSITORY=owner/repo GITHUB_TOKEN=… node scripts/check-scheduler-liveness.mjs
 *   node scripts/check-scheduler-liveness.mjs --json
 */

import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const MAX_SILENT_HOURS = 24
/** A never-fired workflow younger than this is PENDING (first fire delayed by GitHub), not dead. */
export const NEW_WORKFLOW_GRACE_HOURS = 48

/**
 * Expand the minute and hour fields of a 5-field cron into firings per day.
 * Supports `*`, lists, ranges and steps — every shape this repo actually uses.
 * Returns null when the day-of-month/month/day-of-week fields are not all `*`,
 * i.e. when the schedule is not simply daily-periodic; the caller must treat
 * null as "cannot compute", never as zero.
 */
export function firingsPerDay(cron) {
  const parts = String(cron).trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [min, hour, dom, mon, dow] = parts
  if (dom !== "*" || mon !== "*" || dow !== "*") return null

  const expand = (field, max) => {
    const out = new Set()
    for (const term of field.split(",")) {
      const [range, stepRaw] = term.split("/")
      const step = stepRaw === undefined ? 1 : Number(stepRaw)
      if (!Number.isInteger(step) || step < 1) return null
      let lo
      let hi
      if (range === "*") {
        lo = 0
        hi = max
      } else if (range.includes("-")) {
        const [a, b] = range.split("-").map(Number)
        if (!Number.isInteger(a) || !Number.isInteger(b)) return null
        lo = a
        hi = b
      } else {
        const v = Number(range)
        if (!Number.isInteger(v)) return null
        lo = v
        hi = stepRaw === undefined ? v : max
      }
      if (lo < 0 || hi > max || lo > hi) return null
      for (let v = lo; v <= hi; v += step) out.add(v)
    }
    return out.size ? out : null
  }

  const minutes = expand(min, 59)
  const hours = expand(hour, 23)
  if (!minutes || !hours) return null
  return minutes.size * hours.size
}

/**
 * Read every workflow declaring `on.schedule` and return its cron lines.
 * Deliberately a text scan rather than a YAML parse: this must not acquire a
 * parser dependency to answer "does this file have a schedule block", and the
 * shape it looks for (`- cron: "..."` under `schedule:`) is the only shape the
 * GitHub schema permits.
 */
export function scheduledWorkflows(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const file of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(file)) continue
    const src = readFileSync(path.join(dir, file), "utf8")
    // Strip comments so a cron quoted inside prose cannot register as a schedule.
    // Several workflows here document alternative cadences in their headers.
    const code = src
      .split("\n")
      .map((l) => (/^\s*#/.test(l) ? "" : l.replace(/\s+#.*$/, "")))
      .join("\n")
    if (!/^\s*schedule:\s*$/m.test(code)) continue
    const crons = [...code.matchAll(/^\s*-\s*cron:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
    if (crons.length === 0) continue
    out.push({ path: `.github/workflows/${file}`, file, crons })
  }
  return out
}

/**
 * The whole decision, pure so it can be pinned.
 *
 * `observed` maps a workflow FILE name to { lastScheduledRunAt, scheduledRuns }.
 * A file present in the repo but ABSENT from `observed` is a config error, not
 * a pass: it means the API was asked about a workflow it does not know, which
 * is exactly what a rename produces.
 */
/**
 * @param {{
 *   workflows: {path: string, file: string, crons: string[]}[],
 *   observed: Record<string, {lastScheduledRunAt: string|null, scheduledRuns: number, createdAt?: string|null}>,
 *   now: number,
 *   maxSilentHours?: number,
 *   windowHours?: number,
 *   selfFile?: string|null,
 * }} args
 */
export function classifyLiveness({
  workflows,
  observed,
  now,
  maxSilentHours = MAX_SILENT_HOURS,
  windowHours = 24,
  selfFile = null,
  newWorkflowGraceHours = NEW_WORKFLOW_GRACE_HOURS,
}) {
  const rows = []
  const configErrors = []

  for (const wf of workflows) {
    // ⛔ A DETECTOR CANNOT WITNESS ITS OWN SILENCE, so watching itself is not
    // conservatism — it is strictly worse than not watching. If this workflow
    // stops, it does not run, so it never reports; and before its first
    // scheduled tick a manual dispatch would see zero scheduled runs and
    // manufacture a failure. Both directions are wrong, so it is excluded by
    // IDENTITY (the running workflow's own file) rather than by name-matching a
    // string, which a rename would break.
    if (selfFile && wf.file === selfFile) continue

    const perDay = wf.crons.reduce((acc, c) => {
      const n = firingsPerDay(c)
      return acc === null || n === null ? null : acc + n
    }, 0)
    if (perDay === null) {
      configErrors.push(`${wf.file}: cron not parseable as a daily-periodic schedule (${wf.crons.join(" | ")})`)
      continue
    }

    const seen = observed[wf.file]
    if (!seen) {
      configErrors.push(`${wf.file}: declares a schedule but the API returned no run history for it (renamed? never enabled?)`)
      continue
    }

    const expected = (perDay * windowHours) / 24
    const silentHours =
      seen.lastScheduledRunAt === null
        ? Infinity
        : (now - Date.parse(seen.lastScheduledRunAt)) / 3600000
    // ⚠ A workflow that has NEVER fired is dead — unless it is NEW. GitHub delays
    // a fresh schedule's first fire by hours (daily workflows here measured 0/73
    // on time), so a workflow added within the last NEW_WORKFLOW_GRACE_HOURS and
    // still unfired is PENDING, reported as such, and not failed on. Older than
    // that and still unfired is the "cron that never matches" shape below, which
    // stays red. `createdAt` comes from the workflows API; without it (older
    // callers, tests) the grace does not apply and never-fired is dead as before.
    const ageHours = seen.createdAt ? (now - Date.parse(seen.createdAt)) / 3600000 : Infinity
    const pending = seen.lastScheduledRunAt === null && ageHours < newWorkflowGraceHours

    rows.push({
      file: wf.file,
      expectedPerDay: perDay,
      expectedInWindow: Number(expected.toFixed(1)),
      observedInWindow: seen.scheduledRuns,
      silentHours: silentHours === Infinity ? null : Number(silentHours.toFixed(1)),
      pending,
      // A rate is REPORTED, never failed on — see the header. Only silence is red.
      dead: silentHours > maxSilentHours && !pending,
    })
  }

  const dead = rows.filter((r) => r.dead)
  return { rows, dead, configErrors }
}

/** Exit code, extracted so it is pinned rather than inline. */
export function livenessExitCode({ dead, configErrors }) {
  if (configErrors.length > 0) return 2
  return dead.length > 0 ? 1 : 0
}

/**
 * Fetch each watched workflow's recent SCHEDULED runs.
 *
 * `fetchImpl` is injected so the HTTP failure handling can be pinned — the
 * property that matters is that a non-2xx must NEVER read as "nothing to
 * report", which is how a guard reports an all-clear it did not earn.
 *
 * A 404 leaves the workflow ABSENT from the result on purpose: classifyLiveness
 * escalates an absent workflow as a config error, which is what a rename is.
 */
/**
 * @param {{
 *   repo: string, token: string,
 *   workflows: {path: string, file: string, crons: string[]}[],
 *   since: string, selfFile?: string|null,
 *   fetchImpl?: (url: string, init?: object) => Promise<any>,
 * }} args
 * @returns {Promise<Record<string, {lastScheduledRunAt: string|null, scheduledRuns: number, createdAt?: string|null}>>}
 */
export async function fetchObserved({ repo, token, workflows, since, selfFile = null, fetchImpl = fetch }) {
  const observed = {}
  const get = async (url) =>
    fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } })

  for (const wf of workflows) {
    if (selfFile && wf.file === selfFile) continue
    const base = `https://api.github.com/repos/${repo}/actions/workflows/${wf.file}/runs`
    const r = await get(`${base}?event=schedule&per_page=100&created=%3E${encodeURIComponent(since)}`)
    if (r.status === 404) continue
    if (!r.ok) throw new ApiError(`GitHub API ${r.status} for ${wf.file} — this run measured nothing.`)

    const body = await r.json()
    const runs = (body.workflow_runs ?? []).map((x) => x.created_at).sort()
    let last = runs.length ? runs[runs.length - 1] : null
    if (!last) {
      // The newest scheduled run may predate the window. Ask for it separately so
      // "silent for 40h" is distinguishable from "silent for exactly the window".
      const r2 = await get(`${base}?event=schedule&per_page=1`)
      if (!r2.ok && r2.status !== 404) throw new ApiError(`GitHub API ${r2.status} for ${wf.file} (last-run probe).`)
      if (r2.ok) {
        const b2 = await r2.json()
        last = b2.workflow_runs?.[0]?.created_at ?? null
      }
    }
    // Never fired at all: ask when the workflow was CREATED, so classifyLiveness
    // can tell a brand-new schedule (first fire pending) from a dead one.
    let createdAt = null
    if (last === null) {
      const r3 = await get(`https://api.github.com/repos/${repo}/actions/workflows/${wf.file}`)
      if (!r3.ok && r3.status !== 404) throw new ApiError(`GitHub API ${r3.status} for ${wf.file} (created-at probe).`)
      if (r3.ok) createdAt = (await r3.json()).created_at ?? null
    }
    // `createdAt` only when it was probed, so the shape of a normal entry is unchanged.
    observed[wf.file] = { lastScheduledRunAt: last, scheduledRuns: runs.length, ...(createdAt ? { createdAt } : {}) }
  }
  return observed
}

export class ApiError extends Error {}

export function renderReport(result, { maxSilentHours = MAX_SILENT_HOURS, windowHours = 24 } = {}) {
  const lines = [`scheduler liveness — ${result.rows.length} scheduled workflow(s), ${windowHours}h window`, ""]
  for (const r of [...result.rows].sort((a, b) => (b.silentHours ?? 1e9) - (a.silentHours ?? 1e9))) {
    const pct = r.expectedInWindow ? Math.round((100 * r.observedInWindow) / r.expectedInWindow) : 0
    lines.push(
      `  ${r.dead ? "✗" : r.pending ? "⏳" : "·"} ${r.file.padEnd(46)} ` +
        `${String(r.observedInWindow).padStart(3)}/${String(r.expectedInWindow).padStart(5)} (${String(pct).padStart(3)}%)  ` +
        `last ${r.silentHours === null ? "NEVER" : r.silentHours + "h ago"}`,
    )
  }
  if (!result.dead.length && !result.configErrors.length) {
    lines.push(
      "",
      `no workflow is silent beyond ${maxSilentHours}h. ` +
        `⚠ That is NOT "the schedules are healthy" — the percentages above are the real cadence, ` +
        `and this check deliberately does not fail on them (see the header).`,
    )
  }
  return lines.join("\n")
}

async function main() {
  const json = process.argv.includes("--json")
  const repo = process.env.GITHUB_REPOSITORY
  const token = process.env.GITHUB_TOKEN
  if (!repo || !token) {
    console.error("config: GITHUB_REPOSITORY and GITHUB_TOKEN are required.")
    process.exit(2)
  }

  const selfFile = process.env.SELF_WORKFLOW_FILE || null
  const workflows = scheduledWorkflows(".github/workflows")
  if (workflows.length === 0) {
    console.error("config: no scheduled workflows found under .github/workflows — refusing to report an all-clear.")
    process.exit(2)
  }

  const windowHours = 24
  const now = Date.now()
  const since = new Date(now - windowHours * 3600000).toISOString()

  let observed
  try {
    observed = await fetchObserved({ repo, token, workflows, since, selfFile })
  } catch (e) {
    console.error(`::error::${e.message}`)
    process.exit(2)
  }

  const result = classifyLiveness({ workflows, observed, now, windowHours, selfFile })

  if (json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderReport(result, { windowHours }))
    for (const e of result.configErrors) console.error(`::error::${e}`)
    for (const d of result.dead) {
      console.error(
        `::error::${d.file} has not fired on schedule for ${d.silentHours ?? "ever"}h ` +
          `(bound ${MAX_SILENT_HOURS}h). Its schedule is not running.`,
      )
    }
  }

  process.exitCode = livenessExitCode(result)
}

// ⚠ pathToFileURL, NOT a `file://` + argv[1] string compare. argv[1] is an OS
// path and import.meta.url is a URL; they line up on POSIX and never on Windows,
// where main() then silently never runs and the process exits 0 having done
// nothing. Banned at zero by scripts-main-module-guard-works-on-windows.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`unexpected: ${e.message}`)
    process.exit(2)
  })
}
