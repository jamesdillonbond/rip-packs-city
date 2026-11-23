import { describe, it, expect } from "vitest"
import { EventEmitter } from "node:events"
import { focusChildPlan, waitForChild } from "../scripts/panini-focus-child.mjs"

const NOW = 1_800_000_000_000
const base = {
  focusSetIds: [2478, 2469],

  isFocus: false,
  mainDeadlineMs: NOW + 70 * 60000, // 70 min left in the scheduled run
  nowMs: NOW,
  home: "C:\\Users\\TDill",
  env: { PANINI_CDP_URL: "http://localhost:9222", RPC_PANINI_INGEST_URL: "https://x/api/cron/panini-ingest", INGEST_SECRET_TOKEN: "t" } as Record<string, string>,
}

describe("focusChildPlan — the parallel focus scan never touches the scheduled run (2026-11-22)", () => {
  it("starts a child for focus products, with its OWN tab record and capture files", () => {
    const p = focusChildPlan(base)
    expect(p.spawn).toBe(true)
    // The scheduled run's tab file is ~/.panini-runner-tab.json; sharing it would make the child
    // close the scheduled run's live tab at its start.
    expect(p.env.PANINI_RUNNER_TAB_FILE).toBe("C:\\Users\\TDill/.panini-runner-tab-focus.json")
    expect(p.env.PANINI_RUNNER_TAB_FILE).not.toMatch(/\.panini-runner-tab\.json$/)
    expect(p.env.PANINI_OPS_CAPTURE_FILE).toBe("panini-ops-capture-focus.jsonl")
    expect(p.env.PANINI_BACKUP_FILE).toBe("panini-capture-focus.jsonl")
    expect(p.env.PANINI_FOCUS).toBe("1")
    expect(p.env.PANINI_PACK_GRID).toBe("0")
    // keeps the credentials and the CDP Chrome it shares
    expect(p.env.INGEST_SECRET_TOKEN).toBe("t")
    expect(p.env.PANINI_CDP_URL).toBe("http://localhost:9222")
  })

  it("its budget ends BEFORE the scheduled run's deadline (the Task Scheduler kills the tree at 2 h)", () => {
    const p = focusChildPlan(base)
    expect(p.budgetMin).toBe(62)
    expect(p.env.PANINI_RUN_BUDGET_MIN).toBe("62")
    expect(p.env.PANINI_WALK_BUDGET_MIN).toBe("62")
    expect(NOW + Number(p.env.PANINI_RUN_BUDGET_MIN) * 60000).toBeLessThan(base.mainDeadlineMs)
  })

  it("a child never starts another child", () => {
    expect(focusChildPlan({ ...base, isFocus: true }).spawn).toBe(false)
    const p = focusChildPlan(base)
    expect(p.env.PANINI_FOCUS_SPAWN).toBe("0")
    expect(focusChildPlan({ ...base, env: p.env }).spawn).toBe(false)
  })

  it("no child with no focus products, too little time, no CDP Chrome, or PANINI_FOCUS_SPAWN=0", () => {
    expect(focusChildPlan({ ...base, focusSetIds: [] }).spawn).toBe(false)
    expect(focusChildPlan({ ...base, focusSetIds: undefined }).spawn).toBe(false)
    expect(focusChildPlan({ ...base, mainDeadlineMs: NOW + 25 * 60000 }).spawn).toBe(false)
    expect(focusChildPlan({ ...base, env: { ...base.env, PANINI_CDP_URL: "" } }).spawn).toBe(false)
    expect(focusChildPlan({ ...base, env: { ...base.env, PANINI_FOCUS_SPAWN: "0" } }).spawn).toBe(false)
  })

  it("derives focus files from configured capture paths", () => {
    const p = focusChildPlan({ ...base, env: { ...base.env, PANINI_OPS_CAPTURE_FILE: "D:\\logs\\ops.jsonl", PANINI_BACKUP_FILE: "cap.log" } })
    expect(p.env.PANINI_OPS_CAPTURE_FILE).toBe("D:\\logs\\ops-focus.jsonl")
    expect(p.env.PANINI_BACKUP_FILE).toBe("cap.log-focus")
  })
})

describe("waitForChild", () => {
  const fakeChild = () => Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, killed: false, kill() { this.killed = true } })

  it("resolves when the child exits", async () => {
    const c = fakeChild()
    const p = waitForChild(c, 1000)
    c.exitCode = 0
    c.emit("exit", 0)
    expect(await p).toBe("exited")
    expect(c.killed).toBe(false)
  })

  it("kills a child that outlives the timeout", async () => {
    const c = fakeChild()
    expect(await waitForChild(c, 10)).toBe("killed")
    expect(c.killed).toBe(true)
  })

  it("returns at once for no child or one already exited", async () => {
    expect(await waitForChild(null, 10)).toBe("none")
    const c = fakeChild(); c.exitCode = 0
    expect(await waitForChild(c, 10)).toBe("exited")
  })
})
