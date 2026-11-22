import { describe, it, expect } from "vitest"
import { summariseCronJobsFailing } from "@/lib/sentinel/cron-job-failing"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-11-22: `rpc-portfolio-snapshot-packs` failed EVERY run for two nights while
// the fleet-rate arm (>= 10 / 6h) stayed green. This arm names such a job.

const row = (over: Record<string, unknown> = {}) => ({
  jobname: "rpc-portfolio-snapshot-packs",
  latest_status: "failed",
  last_run: "2026-11-22T11:56:00Z",
  fails_in_window: 2,
  runs_in_window: 2,
  last_fail_message: "ERROR:  invalid transaction termination\nCONTEXT:  PL/pgSQL function fill_portfolio_snapshot_pack_values(integer) line 32 at COMMIT",
  ...over,
})

describe("summariseCronJobsFailing", () => {
  it("names a job whose every run in the window failed (the 11-22 case)", () => {
    const v = summariseCronJobsFailing([row()])
    expect(v.status).toBe("warn")
    expect(v.value).toBe(1)
    expect(v.detail).toContain("rpc-portfolio-snapshot-packs (2/2 failed: invalid transaction termination")
  })

  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, {}, "x" as unknown]) {
      const v = summariseCronJobsFailing(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("an empty list is ok and says so with its count", () => {
    const v = summariseCronJobsFailing([])
    expect(v.status).toBe("ok")
    expect(v.value).toBe(0)
    expect(v.detail).toContain("0 pg_cron jobs failed every run in 48h")
  })

  it("CONTROL: an intermittent job (latest failed, some succeeded) is not flagged", () => {
    const v = summariseCronJobsFailing([row({ jobname: "rpc-panini-sale-feed-status-refresh", fails_in_window: 1, runs_in_window: 48 })])
    expect(v.status).toBe("ok")
    expect(v.detail).toContain("(1 with a failed latest run)")
  })

  it("CONTROL: a single failed run cannot be told from a one-off and is not flagged", () => {
    expect(summariseCronJobsFailing([row({ fails_in_window: 1, runs_in_window: 1 })]).status).toBe("ok")
  })

  it("a job whose latest run succeeded is not flagged even if the counts look all-failed", () => {
    expect(summariseCronJobsFailing([row({ latest_status: "succeeded" })]).status).toBe("ok")
  })

  it("missing counts are skipped, not read as zero", () => {
    const v = summariseCronJobsFailing([row({ runs_in_window: null }), row({ jobname: "b", fails_in_window: "3", runs_in_window: "3" })])
    expect(v.status).toBe("warn")
    expect(v.detail).toContain("b (3/3 failed")
    expect(v.detail).not.toContain("rpc-portfolio-snapshot-packs")
  })

  it("lists at most five and says how many more", () => {
    const many = Array.from({ length: 7 }, (_, i) => row({ jobname: `job-${i}`, fails_in_window: 2 + i, runs_in_window: 2 + i }))
    const v = summariseCronJobsFailing(many)
    expect(v.value).toBe(7)
    expect(v.detail).toContain("…and 2 more")
    expect(v.detail.startsWith("7 pg_cron job(s)")).toBe(true)
  })

  it("never pages — warn is the ceiling", () => {
    const many = Array.from({ length: 50 }, (_, i) => row({ jobname: `job-${i}`, fails_in_window: 99, runs_in_window: 99 }))
    expect(summariseCronJobsFailing(many).status).toBe("warn")
  })
})

// The function being right is not the route using it. Pin the wiring.

describe("the sentinel route wires the arm", () => {
  const src = stripComments(readFileSync(join(process.cwd(), "app/api/sentinel/route.ts"), "utf8")) as string

  it("calls check_pgcron_recent_failures over 48 hours and pushes its verdict under the arm's name", () => {
    expect(src).toMatch(/rpc\("check_pgcron_recent_failures",\s*\{\s*p_window:\s*"48 hours",?\s*\}\)/)
    expect(src).toMatch(/summariseCronJobsFailing\(cjData, "48h"\)/)
    expect(src).toContain('const CRON_JOB_FAILING_CHECK_NAME = "pg_cron Job Failing Every Run"')
    expect([...src.matchAll(/name: CRON_JOB_FAILING_CHECK_NAME/g)].length).toBeGreaterThanOrEqual(3)
  })
})
