import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"
import config from "../playwright.config"
import { isBotUserAgent } from "../app/api/track-funnel/route"

// Two properties of the Playwright DOM smoke, pinned 2026-09-25:
//  1. It runs after every successful PRODUCTION deploy (not only every 6h), and
//     only then — a Preview or a pending/failed status must not trigger it.
//  2. Its user agent SELF-IDENTIFIES, so its page views land as bot_ua=true in
//     the funnel. `devices["Desktop Chrome"]` alone does not; it had been
//     counted as human traffic.

const ROOT = path.resolve(__dirname, "..")

describe("e2e smoke user agent", () => {
  it("every project's UA is classified as a bot by the funnel route", () => {
    const projects = config.projects ?? []
    expect(projects.length).toBeGreaterThan(0)
    for (const p of projects) {
      const ua = p.use?.userAgent
      expect(ua, `${p.name} has no explicit userAgent`).toBeTruthy()
      expect(isBotUserAgent(ua), `${p.name} UA reads as human: ${ua}`).toBe(true)
    }
  })

  it("control: the bare device UA it replaces reads as human", async () => {
    const { devices } = await import("playwright")
    expect(isBotUserAgent(devices["Desktop Chrome"].userAgent)).toBe(false)
  })
})

describe("e2e smoke deploy trigger", () => {
  const wf = parse(readFileSync(path.join(ROOT, ".github/workflows/e2e-smoke.yml"), "utf8")) as any
  const cond = String(wf.jobs["dom-smoke"].if ?? "")

  it("listens for deployment_status and keeps its schedule", () => {
    expect(Object.keys(wf.on)).toEqual(expect.arrayContaining(["deployment_status", "schedule", "workflow_dispatch"]))
  })

  it("gates deploy runs on Production + success", () => {
    expect(cond).toContain("github.event.deployment_status.state == 'success'")
    expect(cond).toContain("github.event.deployment.environment == 'Production'")
    expect(cond).toContain("github.event_name != 'deployment_status'")
  })

  it("cancels superseded deploy runs but never a scheduled one", () => {
    expect(wf.concurrency.group).toContain("github.event_name")
    expect(String(wf.concurrency["cancel-in-progress"])).toContain("github.event_name == 'deployment_status'")
  })
})
