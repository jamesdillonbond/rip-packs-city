import { describe, it, expect } from "vitest"
import { summariseAlertDelivery } from "@/lib/sentinel/alert-delivery"

/**
 * The sentinel has recorded per-channel delivery in `extra.notifications` since
 * 2026-08-29 and NOTHING READ IT. Measured 2026-09-11 across all 18 runs in the
 * durable record: `email-FAILED:not_configured` on 18 of 18, then on the
 * 00:01:09Z CRITICAL sweep `telegram-FAILED:http_400 … "message is too long"`.
 * The alarm reached nobody on the one run that mattered.
 *
 * ⚠ The two properties that decide whether this arm is worth having, and both are
 * pinned below rather than described:
 *   1. it fires on ZERO channels, not on "not every channel" — email is
 *      unconfigured today, so the stricter rule would be red from birth and a
 *      permanently-red instrument is indistinguishable from a broken one;
 *   2. a run that never ATTEMPTED a notification is not a failed delivery — the
 *      sentinel only notifies on warn/critical or the six-hourly report, so
 *      counting quiet runs would fabricate an outage out of a healthy estate.
 */

const run = (at: string, notifications: string[]) => ({ started_at: at, notifications })

describe("summariseAlertDelivery", () => {
  it("reproduces the live mute and calls it CRITICAL", () => {
    const v = summariseAlertDelivery([
      run("2026-09-11T00:01:09Z", [
        'telegram-FAILED:http_400: {"ok":false,"description":"Bad Request: message is too long"}',
        "email-FAILED:not_configured",
        "github-actions-native",
      ]),
      run("2026-09-10T09:57:50Z", ["telegram", "email-FAILED:not_configured", "github-actions-native"]),
    ])
    expect(v.status).toBe("critical")
    expect(v.detail).toMatch(/reached NOBODY/)
    // The reason has to travel with the verdict: "the alarm is mute" without
    // "because the message was too long" is the unfalsifiable shape.
    expect(v.detail).toMatch(/message is too long/)
    expect(v.inspected).toBe(2)
  })

  it("stays GREEN while ONE channel works, even though another is permanently down", () => {
    // The load-bearing choice. Email has been not_configured on 18 of 18 runs;
    // an arm that went red for that would have been red since the day it shipped
    // and would have told nobody anything on the day it mattered.
    const v = summariseAlertDelivery([
      run("2026-09-10T09:57:50Z", ["telegram", "email-FAILED:not_configured", "github-actions-native"]),
      run("2026-09-10T05:04:33Z", ["telegram", "email-FAILED:not_configured", "github-actions-native"]),
    ])
    expect(v.status).toBe("warn")
    expect(v.detail).toMatch(/delivered on telegram/)
    // Not silent about it either — the dead channel is named in the detail.
    expect(v.detail).toMatch(/not_configured/)
  })

  it("is plainly ok when every configured channel delivered", () => {
    const v = summariseAlertDelivery([run("2026-09-10T09:57:50Z", ["telegram", "email", "github-actions-native"])])
    expect(v.status).toBe("ok")
    expect(v.detail).toMatch(/delivered on telegram\+email/)
  })

  it("does not treat a quiet run as a failed delivery", () => {
    // ALL CLEAR runs outside the six-hourly slot carry an empty notifications
    // list. Scoring those as "reached nobody" would invent an outage.
    const v = summariseAlertDelivery([
      run("2026-09-10T09:57:50Z", []),
      run("2026-09-10T08:34:00Z", ["github-actions-native"]),
      run("2026-09-10T05:04:33Z", ["telegram", "email-FAILED:not_configured", "github-actions-native"]),
    ])
    expect(v.status).not.toBe("critical")
    expect(v.inspected, "only the one run that actually attempted a channel counts").toBe(1)
  })

  it("says UNMEASURED rather than ok when the sentinel recorded NO runs at all", () => {
    // Absence of evidence is the shape this repo keeps publishing as evidence of
    // absence. No run at all inside retention means the route stopped recording
    // itself, which is not a working alarm.
    for (const rows of [[], null, undefined]) {
      const v = summariseAlertDelivery(rows as any)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
      expect(v.inspected).toBe(0)
    }
  })

  it("stays ok on a QUIET estate, without claiming delivery works", () => {
    // ⚠ THE TWO ZEROES ARE DIFFERENT, and collapsing them made this arm warn on
    // an all-green fixture — caught by the existing deep battery, not by this
    // file. The sentinel notifies only on warn/critical or the six-hourly
    // report, so a healthy window exercises no channel; warning on that is the
    // "a not-vacuous check must be satisfiable at a population of zero" shape,
    // and it would make a green fleet permanently amber.
    const v = summariseAlertDelivery([
      run("2026-09-10T09:57:50Z", []),
      run("2026-09-10T08:34:00Z", ["github-actions-native"]),
    ])
    expect(v.status).toBe("ok")
    expect(v.inspected).toBe(0)
    // The ok is about the ESTATE, never about the channel — it must not read as
    // "delivery is fine", which is the claim nobody measured.
    expect(v.detail).toMatch(/not a claim that it works/)
    expect(v.detail).toMatch(/2 sentinel runs/)
  })

  it("warns when an earlier alert was mute even though the newest got through", () => {
    const v = summariseAlertDelivery([
      run("2026-09-11T02:00:00Z", ["telegram", "email-FAILED:not_configured", "github-actions-native"]),
      run("2026-09-11T00:01:09Z", ["telegram-FAILED:http_400", "email-FAILED:not_configured", "github-actions-native"]),
    ])
    expect(v.status).toBe("warn")
    expect(v.detail).toMatch(/1 of 2 recent alerts reached nobody/)
  })

  it("cannot be inverted by a caller that forgets to order the rows", () => {
    // The verdict keys on the NEWEST attempt. Handed oldest-first, a naive
    // implementation would report the stale row and call a live mute healthy.
    const oldestFirst = [
      run("2026-09-10T09:57:50Z", ["telegram", "github-actions-native"]),
      run("2026-09-11T00:01:09Z", ["telegram-FAILED:http_400", "email-FAILED:not_configured", "github-actions-native"]),
    ]
    expect(summariseAlertDelivery(oldestFirst).status).toBe("critical")
  })

  it("ignores malformed rows without concluding from them", () => {
    const v = summariseAlertDelivery([
      { started_at: "2026-09-11T00:01:09Z", notifications: "not-an-array" },
      { started_at: null, notifications: null },
      run("2026-09-10T09:57:50Z", ["telegram", "github-actions-native"]),
    ] as any)
    expect(v.status).toBe("ok")
    expect(v.inspected).toBe(1)
  })
})
