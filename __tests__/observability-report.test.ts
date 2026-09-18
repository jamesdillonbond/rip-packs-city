import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as Report from "@/lib/observability/report"

// lib/observability/report.ts replaced @sentry/nextjs (known-issues #34,
// 2026-09-18) as the destination for the five server routes' captures. It is
// deliberately the same API subset, so these pin the SEMANTICS the routes and
// their deep tests already rely on: scope tags reach the capture made inside
// the scope, a string level and a context object both work, breadcrumbs are
// buffered and attached to the NEXT capture rather than logged per crumb, and
// every line carries the `[report]` prefix the runtime-error grouping keys on.
describe("observability report shim", () => {
  let err: ReturnType<typeof vi.spyOn>
  let warn: ReturnType<typeof vi.spyOn>
  let log: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    err = vi.spyOn(console, "error").mockImplementation(() => {})
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    log = vi.spyOn(console, "log").mockImplementation(() => {})
  })
  afterEach(() => {
    err.mockRestore()
    warn.mockRestore()
    log.mockRestore()
  })

  it("tags and extra set inside withScope reach the exception captured inside it, and the error object rides along", () => {
    const boom = new Error("boom")
    Report.withScope((scope) => {
      scope.setTag("route", "sales-indexer")
      scope.setExtra("detail", "x")
      Report.captureException(boom)
    })
    expect(err).toHaveBeenCalledTimes(1)
    const [line, passed] = err.mock.calls[0] as [string, unknown]
    expect(line).toMatch(/^\[report\] exception /)
    expect(JSON.parse(line.replace(/^\[report\] exception /, ""))).toMatchObject({
      message: "boom",
      tags: { route: "sales-indexer" },
      extra: { detail: "x" },
    })
    expect(passed).toBe(boom)
  })

  it("scope does not leak: a capture OUTSIDE the scope carries none of its tags", () => {
    Report.withScope((scope) => scope.setTag("route", "inside"))
    Report.captureException(new Error("outside"))
    const line = err.mock.calls[0][0] as string
    expect(JSON.parse(line.replace(/^\[report\] exception /, "")).tags).toEqual({})
  })

  it("captureMessage takes a string level (smoke-test's form) and routes error to console.error", () => {
    Report.captureMessage("smoke test failed: x", "error")
    expect(err).toHaveBeenCalledTimes(1)
    expect(err.mock.calls[0][0]).toMatch(/^\[report\] message .*smoke test failed: x/)
  })

  it("captureMessage takes a context object (the indexers' form) and routes warning to console.warn with tags + extra", () => {
    Report.captureMessage("listing_resolution_failures_inserted", {
      level: "warning",
      tags: { collection: "nfl_all_day" },
      extra: { queued_failures: 3 },
    })
    expect(warn).toHaveBeenCalledTimes(1)
    const payload = JSON.parse((warn.mock.calls[0][0] as string).replace(/^\[report\] message /, ""))
    expect(payload).toMatchObject({ tags: { collection: "nfl_all_day" }, extra: { queued_failures: 3 } })
  })

  it("breadcrumbs are buffered, bounded, and attached to the NEXT capture — never one line each", () => {
    for (let i = 0; i < 60; i++) Report.addBreadcrumb({ category: "listing-retry", message: `crumb-${i}` })
    expect(log).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(Report.pendingBreadcrumbs()).toHaveLength(50)
    Report.captureMessage("page", { level: "warning" })
    const payload = JSON.parse((warn.mock.calls[0][0] as string).replace(/^\[report\] message /, ""))
    expect(payload.breadcrumbs).toHaveLength(50)
    expect(payload.breadcrumbs[49]).toMatchObject({ message: "crumb-59" })
    // Drained: the next capture starts clean.
    Report.captureMessage("again", { level: "warning" })
    expect(JSON.parse((warn.mock.calls[1][0] as string).replace(/^\[report\] message /, "")).breadcrumbs).toEqual([])
  })

  it("captureRequestError (Next's onRequestError hook) records the route and method as tags", () => {
    Report.captureRequestError(new Error("unhandled"), { path: "/api/x", method: "POST" }, { routePath: "/api/x", routeType: "route", routerKind: "App Router" })
    const payload = JSON.parse((err.mock.calls[0][0] as string).replace(/^\[report\] exception /, ""))
    expect(payload.tags).toMatchObject({ route: "/api/x", method: "POST", routeType: "route" })
  })
})
