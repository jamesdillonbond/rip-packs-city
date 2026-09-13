import { describe, it, expect } from "vitest"
import { buildSentinelFindings } from "../app/api/sentinel/route"

// 🚨 WHY THIS FILE EXISTS — a measurement, not a worry.
//
// Until 2026-09-13 the sentinel's durable row (`pipeline_runs.extra`) carried
// `critical` and `warn` as check NAMES only. Every per-pipeline fact an arm
// produced — which pipeline, how many minutes, against which threshold — lived
// ONLY in the Telegram/email body. So the database could not answer "has the
// no-success arm ever named `reconcile-saved-wallet-stats`?", and asking it
// returned a confident ZERO across 21 sentinel runs. That zero was meaningless:
// no key in the row had ever held a pipeline name, so the query could not have
// matched for ANY pipeline. It was one step from being published as a refutation
// of a real defect.
//
// ⭐ The estate's own rule, failing on the instrument that exists to make other
// instruments checkable: *a zero needs a positive control in the same
// instrument.*
//
// ⚠ AND THE CAPS ARE TESTED HERE RATHER THAN THROUGH THE ROUTE BECAUSE THROUGH
// THE ROUTE THEY CANNOT BE. No sentinel fixture produces a 400-character detail,
// so a route-level assertion on the cap passes whether or not the cap exists —
// verified by deleting the `.slice()` and watching the suite stay green. Pure
// function, synthetic inputs, caps actually exercised.

const long = (n: number) => "x".repeat(n)

describe("buildSentinelFindings — the detail survives into the durable row", () => {
  it("keeps the detail of every non-ok check, with its status", () => {
    const out = buildSentinelFindings([
      { name: "Pipeline Success", status: "warn", detail: "foo 972m since the last success (>360m, medium)" },
      { name: "Sales Freshness", status: "critical", detail: "0 new sales in last 2 hours" },
    ])
    expect(out).toEqual([
      { name: "Pipeline Success", status: "warn", detail: "foo 972m since the last success (>360m, medium)" },
      { name: "Sales Freshness", status: "critical", detail: "0 new sales in last 2 hours" },
    ])
  })

  it("drops ok checks — an all-clear has nothing to explain and this row is read every tick", () => {
    const out = buildSentinelFindings([
      { name: "Green One", status: "ok", detail: "all good" },
      { name: "Bad One", status: "warn", detail: "not good" },
    ])
    expect(out.map((f) => f.name)).toEqual(["Bad One"])
  })

  it("⭐ CAPS THE DETAIL — the assertion the route-level test could not make", () => {
    const [f] = buildSentinelFindings([{ name: "n", status: "warn", detail: long(5000) }])
    expect(f.detail.length).toBe(400)
  })

  it("⭐ CAPS THE COUNT, so a pathological run cannot bloat every row", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `c${i}`, status: "warn", detail: "d" }))
    expect(buildSentinelFindings(many).length).toBe(25)
  })

  it("🚨 REDACTS — `extra` is far more widely readable than a log line", () => {
    // This estate keeps a Telegram bot token IN A URL PATH, and a check's detail
    // can quote an upstream URL. A raw detail here would be a live credential in
    // a table the alert views join.
    const [f] = buildSentinelFindings([
      { name: "n", status: "warn", detail: "failed: https://api.telegram.org/bot123456789:AAFakeTokenValueForTest/sendMessage" },
    ])
    expect(f.detail).not.toContain("AAFakeTokenValueForTest")
  })

  it("a missing detail becomes an empty string, never the literal `undefined`", () => {
    const [f] = buildSentinelFindings([{ name: "n", status: "critical" }])
    expect(f.detail).toBe("")
  })
})
