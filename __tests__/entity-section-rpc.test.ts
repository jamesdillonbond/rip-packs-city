import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

// Unit tests for lib/entity-section-rpc.ts — the section-level fetch policy on
// the five entity SEO routes.
//
// The defect this module closes: every section fetcher used to `return []` on
// error, which rendered a PLAUSIBLE EMPTY STATE (a real franchise with an empty
// roster) and reached neither Sentry nor any health check. The policy is:
//   - retry connection-class errors (the pool-acquire timeouts the team page's
//     six-way fan-out produces),
//   - THROW on a structural section so the failure is honest and retryable,
//   - degrade to empty on a decorative one, with a greppable log line.
//
// supabaseAdmin is mocked because the module imports it at load time; the
// retry wrapper is exercised for real (with its default backoff, so every
// transient case here resolves on an early attempt to keep the suite fast).

const rpcMock = vi.fn()

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    get rpc() {
      return rpcMock
    },
  },
}))

import { sectionRow, sectionRows } from "@/lib/entity-section-rpc"

const ok = (data: unknown) => ({ data, error: null })
const poolTimeout = () => ({
  data: null,
  error: { message: "Timed out acquiring connection from connection pool." },
})
const logicError = () => ({ data: null, error: { code: "42883", message: "function does not exist" } })

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  rpcMock.mockReset()
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
})

describe("sectionRows", () => {
  it("returns rows on first success without retrying", async () => {
    rpcMock.mockResolvedValueOnce(ok([{ id: 1 }, { id: 2 }]))
    const rows = await sectionRows("team roster", "get_team_players", { p_a: 1 })
    expect(rows).toEqual([{ id: 1 }, { id: 2 }])
    expect(rpcMock).toHaveBeenCalledTimes(1)
    expect(rpcMock).toHaveBeenCalledWith("get_team_players", { p_a: 1 })
  })

  it("rides out a pool-acquire timeout and returns the eventual rows", async () => {
    rpcMock.mockResolvedValueOnce(poolTimeout()).mockResolvedValueOnce(ok([{ id: 7 }]))
    const rows = await sectionRows("team roster", "get_team_players", {}, { structural: true })
    expect(rows).toEqual([{ id: 7 }])
    expect(rpcMock).toHaveBeenCalledTimes(2)
  })

  it("an empty result is NOT an error — a genuinely empty section stays empty", async () => {
    rpcMock.mockResolvedValueOnce(ok([]))
    const rows = await sectionRows("team activity", "get_team_activity", {}, { structural: true })
    expect(rows).toEqual([])
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it("THROWS for a structural section once retries are exhausted", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    await expect(
      sectionRows("team roster", "get_team_players", {}, { structural: true }),
    ).rejects.toThrow(/team roster unavailable/)
  })

  it("degrades to empty for a decorative section once retries are exhausted", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    const rows = await sectionRows("team squeeze", "get_team_squeeze", {})
    expect(rows).toEqual([])
  })

  it("logs the degradation under a greppable [entity-section] prefix", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    await sectionRows("team squeeze", "get_team_squeeze", {})
    const line = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")
    expect(line).toContain("[entity-section]")
    expect(line).toContain("get_team_squeeze")
    expect(line).toContain("degrading to empty")
  })

  it("does not retry a 42xxx logic error — it fails fast on the first attempt", async () => {
    rpcMock.mockResolvedValue(logicError())
    const rows = await sectionRows("team sets", "get_team_sets", {})
    expect(rows).toEqual([])
    expect(rpcMock).toHaveBeenCalledTimes(1)
  })

  it("coerces a non-array success payload to an empty list", async () => {
    rpcMock.mockResolvedValueOnce(ok({ not: "an array" }))
    expect(await sectionRows("team sets", "get_team_sets", {})).toEqual([])
  })
})

describe("sectionRow", () => {
  it("returns a single object payload as-is", async () => {
    rpcMock.mockResolvedValueOnce(ok({ opponent: "LAL" }))
    expect(await sectionRow("team next game", "get_team_next_game", {})).toEqual({ opponent: "LAL" })
  })

  it("unwraps a one-row array payload", async () => {
    rpcMock.mockResolvedValueOnce(ok([{ opponent: "BOS" }]))
    expect(await sectionRow("team next game", "get_team_next_game", {})).toEqual({ opponent: "BOS" })
  })

  it("returns null for an empty array payload", async () => {
    rpcMock.mockResolvedValueOnce(ok([]))
    expect(await sectionRow("team next game", "get_team_next_game", {})).toBeNull()
  })

  it("degrades to null for a decorative section after retries", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    expect(await sectionRow("team next game", "get_team_next_game", {})).toBeNull()
  })

  it("THROWS for a structural section after retries", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    await expect(sectionRow("some hero", "get_hero", {}, { structural: true })).rejects.toThrow(
      /some hero unavailable/,
    )
  })
})
