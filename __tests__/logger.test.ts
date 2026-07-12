import { describe, it, expect, vi, afterEach } from "vitest"
import { log } from "@/lib/logger"

// lib/logger.ts emits single-line JSON to console.log (never console.warn/error,
// which Vercel's log search does not index). Locks the wire format that log
// drains parse: level/tag/msg/ts + merged meta, and structured error extraction.

function lastLogged(spy: any) {
  const call = spy.mock.calls.at(-1)
  return JSON.parse(call[0])
}

afterEach(() => vi.restoreAllMocks())

describe("log", () => {
  it("info emits parseable JSON with level/tag/msg/ts and merged meta on console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log.info("sniper-feed", "fetched listings", { source: "flowty", count: 42 })
    const e = lastLogged(spy)
    expect(e.level).toBe("info")
    expect(e.tag).toBe("sniper-feed")
    expect(e.msg).toBe("fetched listings")
    expect(e.source).toBe("flowty")
    expect(e.count).toBe(42)
    expect(typeof e.ts).toBe("string")
    expect(Number.isNaN(Date.parse(e.ts))).toBe(false)
  })

  it("routes warn through console.log too (never console.warn — unindexed by Vercel)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    log.warn("fmv", "stale")
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(lastLogged(logSpy).level).toBe("warn")
  })

  it("error extracts message + stack from an Error instance", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log.error("fmv-recalc", "boom", { editionKey: "84:2892" }, new Error("kaboom"))
    const e = lastLogged(spy)
    expect(e.level).toBe("error")
    expect(e.editionKey).toBe("84:2892")
    expect(e.error).toBe("kaboom")
    expect(typeof e.stack).toBe("string")
  })

  it("error stringifies a non-Error thrown value", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {})
    log.error("tag", "msg", undefined, "plain-string-failure")
    const e = lastLogged(spy)
    expect(e.error).toBe("plain-string-failure")
    expect(e.stack).toBeUndefined()
  })
})
