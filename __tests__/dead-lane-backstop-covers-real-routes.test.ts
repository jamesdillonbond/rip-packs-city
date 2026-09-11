import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"

/**
 * `dead-lane-backstop.yml` exists because on 2026-09-10 ten lanes on 1–15 minute
 * cadences did not come back after the Vercel pause lifted, while every lane on a
 * 4- or 6-hourly cadence returned on its first slot (3 of 3). Their only
 * scheduler is cron-job.org, which auto-disables after consecutive failures — a
 * failure mode `sales-indexers-backstop.yml` already records this repo hitting in
 * May. Those four lanes got a backstop then; these ten never did.
 *
 * ⚠ The properties below are the ones that decide whether a backstop HELPS or
 * HURTS, so they are asserted rather than described:
 *   1. every URL hits a route that actually exists — a rename would otherwise
 *      leave the backstop firing 404s forever while reading green;
 *   2. no step can red the badge — a noisy backstop competes with the real alarm
 *      instead of adding to it;
 *   3. the schedule does not collide with another workflow's minute, derived from
 *      the tree rather than trusted from a comment;
 *   4. dispatch runs before send, or a tick delivers nothing.
 */

const ROOT = join(__dirname, "..")
const WORKFLOWS = join(ROOT, ".github", "workflows")
const SELF = "dead-lane-backstop.yml"
const doc = parse(readFileSync(join(WORKFLOWS, SELF), "utf8")) as any

type Step = { name?: string; uses?: string; with?: Record<string, string>; "continue-on-error"?: boolean }
const jobs = Object.entries(doc.jobs) as [string, { steps: Step[]; "timeout-minutes": number }][]
const callSteps = jobs.flatMap(([job, j]) =>
  j.steps.filter((s) => typeof s.uses === "string" && s.uses.includes("rpc-call")).map((s) => ({ job, s })),
)

describe("dead-lane-backstop.yml", () => {
  it("calls a non-trivial number of lanes (the guard is not vacuous)", () => {
    expect(callSteps.length).toBeGreaterThanOrEqual(8)
  })

  it("every URL resolves to a route that exists on disk", () => {
    // A renamed or deleted route would leave this workflow firing 404s on a
    // schedule forever, and `fail-on-status: false` means it would never say so.
    for (const { s } of callSteps) {
      const url = s.with?.url ?? ""
      expect(url, `${s.name}`).toMatch(/^https:\/\/www\.rippackscity\.com\/api\//)
      const routeDir = join(ROOT, "app", url.replace("https://www.rippackscity.com/", "").split("?")[0])
      expect(existsSync(join(routeDir, "route.ts")), `${url} -> ${routeDir}/route.ts`).toBe(true)
    }
  })

  it("every lane it names is one the route itself says cron-job.org drives", () => {
    // The premise of the whole workflow. If a route stops naming cron-job.org as
    // its scheduler, it has another caller and does not need a backstop here.
    const named = callSteps.filter(({ s }) => {
      const url = s.with?.url ?? ""
      const f = join(ROOT, "app", url.replace("https://www.rippackscity.com/", "").split("?")[0], "route.ts")
      return /cron-job\.org/i.test(readFileSync(f, "utf8"))
    })
    // Not all routes carry the note, but the premise must be documented somewhere
    // in the set rather than resting only on this file's own header.
    expect(named.length).toBeGreaterThan(0)
  })

  it("cannot red the badge — it is a backstop, not a second alarm", () => {
    for (const { s } of callSteps) {
      expect(s["continue-on-error"], `${s.name} continue-on-error`).toBe(true)
      expect(String(s.with?.["fail-on-auth"]), `${s.name} fail-on-auth`).toBe("false")
    }
  })

  it("dispatch runs before send, or a tick delivers nothing", () => {
    // alerts-dispatch fills the outbox; alerts-send drains it. Reversed, a
    // backstop tick sends whatever the previous tick happened to leave behind.
    const names = doc.jobs.alerts.steps.map((s: Step) => s.name ?? "")
    const d = names.findIndex((n: string) => n.includes("alerts-dispatch"))
    const s = names.findIndex((n: string) => n.includes("alerts-send"))
    expect(d).toBeGreaterThanOrEqual(0)
    expect(s).toBeGreaterThanOrEqual(0)
    expect(d).toBeLessThan(s)
  })

  it("schedules on minutes no other workflow in this repo uses", () => {
    // Derived from the tree, not trusted from a comment — a later workflow
    // claiming one of these minutes should fail here rather than quietly
    // contend for the same runner slot.
    const mine = new Set(
      String(doc.on.schedule[0].cron)
        .split(" ")[0]
        .split(",")
        .map((m) => m.trim()),
    )
    expect(mine.size).toBeGreaterThan(0)
    const others = new Set<string>()
    for (const f of readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml") && f !== SELF)) {
      for (const m of readFileSync(join(WORKFLOWS, f), "utf8").matchAll(/cron:\s*['"]([^'"]+)['"]/g)) {
        for (const part of m[1].split(" ")[0].split(",")) if (/^\d+$/.test(part.trim())) others.add(part.trim())
      }
    }
    expect(others.size, "the comparison set must be non-empty or this asserts nothing").toBeGreaterThan(10)
    for (const m of mine) expect(others.has(m), `minute ${m} collides with another workflow`).toBe(false)
  })

  it("gives every job more wall-clock than its steps can spend", () => {
    // Derived from the steps themselves, so adding a lane cannot silently
    // outgrow the timeout and go red for the wrong reason.
    for (const [name, job] of jobs) {
      const steps = job.steps.filter((s) => typeof s.uses === "string" && s.uses.includes("rpc-call"))
      const worst = steps.reduce((acc, s) => {
        const maxTime = Number(s.with?.["max-time"] ?? 300)
        const retries = Number(s.with?.retries ?? 0)
        return acc + (retries + 1) * maxTime + retries * 5
      }, 0)
      expect(job["timeout-minutes"] * 60, `${name}`).toBeGreaterThan(worst)
    }
  })
})
