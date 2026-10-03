// __tests__/panini-team-walk-deadlines.test.ts
//
// 2026-10-03: three of five laptop team walks (09-29, 09-30, 10-03) went silent right after
// "backing off 20s before attempt 2" and sat ~130 min until the 160-min watchdog killed them —
// one team walked instead of five. Response.text(), page.title() and page.evaluate() carry no
// timeout of their own, and a Cloudflare challenge tab that stops answering parks them forever.
// Pinned here:
//   - withDeadline returns TIMED_OUT for a call that never settles, and the value otherwise;
//   - the attempt ceiling sits ABOVE every bounded step of a healthy attempt (a slow page is
//     never cut — only a hung one);
//   - inside the walker, no browser call that lacks its own timeout runs unwrapped, and no
//     pause depends on a live tab (page.waitForTimeout).

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TIMED_OUT, sleep, withDeadline } from "../scripts/lib/with-deadline.mjs"
import { ATTEMPT_DEADLINE_MS, BODY_READ_DEADLINE_MS, DIAGNOSTIC_DEADLINE_MS } from "../scripts/panini-team-walk.mjs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

describe("withDeadline", () => {
  it("returns TIMED_OUT when the call never settles", async () => {
    const never = new Promise(() => {})
    expect(await withDeadline(never, 20)).toBe(TIMED_OUT)
  })

  it("returns the value when the call settles first", async () => {
    expect(await withDeadline(sleep(5).then(() => "ok"), 1_000)).toBe("ok")
  })

  it("passes a rejection through, and an abandoned call that rejects later is not unhandled", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 1_000)).rejects.toThrow("boom")
    const late = sleep(30).then(() => {
      throw new Error("late")
    })
    expect(await withDeadline(late, 5)).toBe(TIMED_OUT)
    await sleep(40) // an unhandled rejection here would fail the run
  })
})

describe("attempt deadline ordering", () => {
  it("leaves room for every bounded step of a healthy attempt", () => {
    // goto (60 s) runs alongside the products wait (45 s) + its body read; then two diagnostics.
    const healthyWorstCase = Math.max(60_000, 45_000 + BODY_READ_DEADLINE_MS) + 2 * DIAGNOSTIC_DEADLINE_MS
    expect(ATTEMPT_DEADLINE_MS).toBeGreaterThan(healthyWorstCase)
  })
})

describe("the walker bounds every call that has no timeout of its own", () => {
  const src = stripComments(readFileSync(join(process.cwd(), "scripts/panini-team-walk.mjs"), "utf8"))
  const lines = src.split("\n")

  it("inspects a non-empty walker", () => {
    expect(lines.filter((l) => /\.(text|title|evaluate|close)\(/.test(l)).length).toBeGreaterThanOrEqual(4)
  })

  it("wraps every .text() / .title() / .evaluate() / .close() in withDeadline", () => {
    const naked = lines.filter((l) => /\.(text|title|evaluate|close)\(/.test(l) && !l.includes("withDeadline("))
    expect(naked).toEqual([])
  })

  it("never pauses on page.waitForTimeout", () => {
    expect(src).not.toMatch(/waitForTimeout\(/)
  })
})
