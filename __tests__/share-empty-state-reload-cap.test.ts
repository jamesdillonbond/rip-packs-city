// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest"

/**
 * 2026-10-22: /share/<wallet>'s empty state reloads when its poll sees moments. If the reloaded page
 * still renders empty, the remount restarted the poll at attempt 0 and reloaded again — 36 reloads
 * in 6 minutes for one visitor. claimAutoReload caps it at two per wallet per 10 minutes.
 */
import { claimAutoReload } from "@/app/share/[wallet]/ShareEmptyState"

beforeEach(() => window.sessionStorage.clear())

describe("claimAutoReload", () => {
  it("allows two automatic reloads, then refuses — the loop is bounded", () => {
    const t = 1_000_000
    expect(claimAutoReload("0xAbC", t)).toBe(true)
    expect(claimAutoReload("0xabc", t + 9_000)).toBe(true)
    expect(claimAutoReload("0xABC", t + 18_000)).toBe(false)
    expect(claimAutoReload("0xabc", t + 27_000)).toBe(false)
  })
  it("the window expires (a later, separate visit may auto-reload again)", () => {
    const t = 1_000_000
    claimAutoReload("0xabc", t)
    claimAutoReload("0xabc", t + 1)
    expect(claimAutoReload("0xabc", t + 10 * 60_000 + 2)).toBe(true)
  })
  it("CONTROL: another wallet has its own budget", () => {
    claimAutoReload("0xabc", 1)
    claimAutoReload("0xabc", 2)
    expect(claimAutoReload("0xdef", 3)).toBe(true)
  })
  it("unreadable storage never loops (no count → no automatic reload)", () => {
    window.sessionStorage.setItem("rpc_share_reloads:0xabc", "{not json")
    expect(claimAutoReload("0xabc", 1)).toBe(false)
  })
})
