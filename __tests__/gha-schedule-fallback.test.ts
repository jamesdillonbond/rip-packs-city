// 2026-11-17. Two things this file holds in place:
//   1. scripts/gha-schedule-fallback.mjs — the laptop-side dispatcher used while GitHub delivers no `schedule`
//      events — matches crons correctly (including the `m-m` form every workflow was rewritten to that day) and
//      knows the inputs for every workflow whose dispatched run would otherwise differ from its scheduled run.
//   2. A job gated on `github.event.schedule == '<cron>'` names a cron that EXISTS in its file. The 11-17
//      rewrite turned '41 6 * * *' into '41-41 6 * * *' but left the `if:` on the old text, so ops-monitor's daily
//      data-integrity job and both badge-sync sweeps would never have run again once schedules resumed.
// Derivation: the workflow list is a tree walk of .github/workflows, never a curated list.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { INPUTS, cronMatches, cronsOf, fieldMatches, lastFireAt } from "../scripts/gha-schedule-fallback.mjs"

const dir = join(__dirname, "..", ".github", "workflows")
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((file) => ({ file, yaml: readFileSync(join(dir, file), "utf8") }))
const scheduled = workflows.filter((w) => cronsOf(w.yaml).length > 0)

const at = (iso: string) => new Date(iso)

describe("cron matching", () => {
  it("handles *, */n, a-b, a-b/n, lists and the m-m form", () => {
    expect(fieldMatches("*", 7)).toBe(true)
    expect(fieldMatches("*/6", 12)).toBe(true)
    expect(fieldMatches("*/6", 13)).toBe(false)
    expect(fieldMatches("15-15", 15)).toBe(true)
    expect(fieldMatches("15-15", 16)).toBe(false)
    expect(fieldMatches("12-12,27,42,57", 42)).toBe(true)
    expect(fieldMatches("12-12,27,42,57", 43)).toBe(false)
    expect(fieldMatches("10-20/5", 15)).toBe(true)
    expect(fieldMatches("10-20/5", 16)).toBe(false)
  })

  it("matches the UTC minute, hour and weekday", () => {
    expect(cronMatches("41-41 17 * * 1", at("2026-11-16T17:41:30Z"))).toBe(true) // a Monday
    expect(cronMatches("41-41 17 * * 1", at("2026-11-17T17:41:00Z"))).toBe(false) // Tuesday
    expect(cronMatches("37-37 1,7,13,19 * * *", at("2026-11-17T13:37:00Z"))).toBe(true)
    expect(cronMatches("37-37 1,7,13,19 * * *", at("2026-11-17T14:37:00Z"))).toBe(false)
  })

  it("finds the most recent fire time inside the lookback, and null outside it", () => {
    expect(lastFireAt("5-5,25,45 * * * *", at("2026-11-17T10:30:10Z"), 60)?.toISOString()).toBe("2026-11-17T10:25:00.000Z")
    expect(lastFireAt("17-17 16 * * 3", at("2026-11-17T10:00:00Z"), 360)).toBeNull()
  })
})

describe("every scheduled workflow is dispatchable by the fallback", () => {
  it("reads a non-trivial set of scheduled workflows", () => {
    expect(scheduled.length).toBeGreaterThanOrEqual(20)
  })

  it("each one accepts workflow_dispatch and has crons that fire within a week", () => {
    const bad: string[] = []
    for (const w of scheduled) {
      if (!/^\s*workflow_dispatch:/m.test(w.yaml)) bad.push(`${w.file}: no workflow_dispatch`)
      for (const c of cronsOf(w.yaml)) {
        if (!lastFireAt(c, at("2026-11-17T12:00:00Z"), 8 * 24 * 60)) bad.push(`${w.file}: cron never fires (${c})`)
      }
    }
    expect(bad).toEqual([])
  })

  it("a workflow that branches on schedule-vs-dispatch has fallback INPUTS", () => {
    const branches = (yaml: string) => /github\.event_name\s*==\s*['"]schedule['"]|github\.event\.schedule/.test(yaml)
    const missing = scheduled.filter((w) => branches(w.yaml) && !(w.file in INPUTS)).map((w) => w.file)
    expect(missing).toEqual([])
    // planted: a workflow body that branches on the schedule is detected
    expect(branches("APPLY: ${{ github.event_name == 'schedule' }}")).toBe(true)
  })

  it("ufc-aptos-sales-ingest is dispatched with apply=true (its dispatch default is a dry run)", () => {
    expect(INPUTS["ufc-aptos-sales-ingest.yml"]()).toEqual(["-f", "apply=true"])
  })
})

describe("a job gated on github.event.schedule names a cron its file declares", () => {
  const gates = (yaml: string) => [...yaml.matchAll(/github\.event\.schedule\s*==\s*'([^']+)'/g)].map((m) => m[1])
  const stale = (yaml: string) => {
    const crons = new Set(cronsOf(yaml))
    return gates(yaml).filter((g) => !crons.has(g))
  }

  it("holds for every workflow", () => {
    const bad = workflows.flatMap((w) => stale(w.yaml).map((g) => `${w.file}: if compares to '${g}', not a declared cron`))
    expect(bad).toEqual([])
  })

  it("detects the 11-17 shape: a cron rewritten to m-m with the if left on the old text", () => {
    const yaml = "on:\n  schedule:\n    - cron: '41-41 6 * * *'\njobs:\n  x:\n    if: github.event.schedule == '41 6 * * *'\n"
    expect(stale(yaml)).toEqual(["41 6 * * *"])
  })
})
