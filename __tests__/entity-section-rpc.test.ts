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

import { sectionRow, sectionRows, sectionRowResult, sectionRowsResult, structuralSection } from "@/lib/entity-section-rpc"

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

  it("a genuinely empty section is not retried — [] is a successful answer", async () => {
    // ⚠ RETITLED 2026-08-21. This used to read "an empty result is NOT an error
    // — a genuinely empty section stays empty", and a ledger entry cited it as
    // "the three-state distinction the canon requires". It is not that: the
    // assertion below and the one in "degrades to empty for a decorative
    // section" are BOTH `toEqual([])`, for two DIFFERENT states. Same value,
    // adjacent tests — the two-state collapse the canon forbids, sitting under a
    // title that claimed the opposite.
    //
    // What this case actually proves is narrower and still worth keeping: an
    // empty success is not treated as a failure, so it costs no retries. The
    // distinction itself is proved below, against sectionRowsResult.
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

  it("⚠ sectionRows CANNOT distinguish a failed read from an empty one — this is the collapse", async () => {
    // Pinned deliberately, as the thing that makes the three-state API necessary.
    // A caller holding only this return value has nothing to discriminate on, so
    // any "No sales yet." it renders is published out of a failed read. Do not
    // "fix" this by changing sectionRows' shape — every existing caller depends
    // on it; reach for sectionRowsResult instead.
    rpcMock.mockResolvedValueOnce(ok([]))
    const empty = await sectionRows("team squeeze", "get_team_squeeze", {})
    rpcMock.mockResolvedValue(poolTimeout())
    const failed = await sectionRows("team squeeze", "get_team_squeeze", {})
    expect(failed).toEqual(empty)
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

describe("sectionRowsResult / sectionRowResult — the three states, kept apart", () => {
  it("read ok + rows → ok:true with the rows", async () => {
    rpcMock.mockResolvedValueOnce(ok([{ id: 1 }]))
    expect(await sectionRowsResult("edition recent sales", "get_edition_recent_sales", {}))
      .toEqual({ rows: [{ id: 1 }], ok: true })
  })

  it("read ok + genuinely empty → ok:TRUE with []", async () => {
    rpcMock.mockResolvedValueOnce(ok([]))
    const res = await sectionRowsResult("edition recent sales", "get_edition_recent_sales", {})
    expect(res.rows).toEqual([])
    // The half that matters: an honest empty section must NOT read as degraded,
    // or every quiet edition renders a false "unavailable" banner.
    expect(res.ok).toBe(true)
  })

  it("read FAILED + decorative → ok:FALSE, and the reason travels with it", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    const res = await sectionRowsResult("edition recent sales", "get_edition_recent_sales", {})
    expect(res.rows).toEqual([])
    expect(res.ok).toBe(false)
    expect(res.error).toContain("connection pool")
  })

  it("the two [] cases are DISTINGUISHABLE here — the whole point", async () => {
    rpcMock.mockResolvedValueOnce(ok([]))
    const empty = await sectionRowsResult("s", "fn", {})
    rpcMock.mockResolvedValue(poolTimeout())
    const failed = await sectionRowsResult("s", "fn", {})
    expect(empty.rows).toEqual(failed.rows)   // same rows…
    expect(empty.ok).not.toBe(failed.ok)      // …different state
  })

  it("read FAILED + structural still THROWS — the policy is unchanged", async () => {
    rpcMock.mockResolvedValue(poolTimeout())
    await expect(sectionRowsResult("team roster", "get_team_players", {}, { structural: true }))
      .rejects.toThrow(/team roster unavailable/)
  })

  it("sectionRows is implemented on the result form and is byte-identical in behaviour", async () => {
    // Guards the refactor itself: if the wrapper ever stops delegating, the two
    // can drift and every existing caller silently changes.
    rpcMock.mockResolvedValueOnce(ok([{ a: 1 }]))
    const viaResult = (await sectionRowsResult("s", "fn", {})).rows
    rpcMock.mockResolvedValueOnce(ok([{ a: 1 }]))
    const viaPlain = await sectionRows("s", "fn", {})
    expect(viaPlain).toEqual(viaResult)
  })

  it("sectionRowResult separates a null row from a failed read", async () => {
    rpcMock.mockResolvedValueOnce(ok(null))
    expect(await sectionRowResult("s", "fn", {})).toEqual({ row: null, ok: true })
    rpcMock.mockResolvedValue(poolTimeout())
    const failed = await sectionRowResult("s", "fn", {})
    expect(failed.row).toBeNull()
    expect(failed.ok).toBe(false)
  })

  it("sectionRowResult unwraps a one-row array and reports ok", async () => {
    rpcMock.mockResolvedValueOnce(ok([{ z: 9 }]))
    expect(await sectionRowResult("s", "fn", {})).toEqual({ row: { z: 9 }, ok: true })
  })
})

describe("structuralSection — the throw is absorbed at the SECTION, not the page", () => {
  it("a throwing structural read becomes ok:false instead of rejecting", async () => {
    const res = await structuralSection<number>("series editions", Promise.reject(new Error("series editions unavailable: canceling statement due to statement timeout")))
    expect(res.ok).toBe(false)
    expect(res.rows).toEqual([])
  })

  it("a successful read passes straight through", async () => {
    const res = await structuralSection<number>("series editions", Promise.resolve([1, 2, 3]))
    expect(res).toEqual({ rows: [1, 2, 3], ok: true })
  })

  it("⚠ the two [] cases stay DISTINGUISHABLE — rows alone would collapse them", async () => {
    const failed = await structuralSection<number>("t", Promise.reject(new Error("boom")))
    const empty = await structuralSection<number>("t", Promise.resolve([]))
    expect(failed.rows).toEqual(empty.rows)
    expect(failed.ok).not.toBe(empty.ok)
  })

  it("🚨 SIBLINGS IN A SHARED Promise.all SURVIVE — the defect this closes", async () => {
    // A rejected Promise.all discards its SETTLED siblings. The team page fans
    // out six ways, so one roster timeout used to cost five sections that had
    // already come back. Assert the five, not just the one.
    const [roster, topEditions, activity, sets, squeeze, nextGame] = await Promise.all([
      structuralSection<string>("team roster", Promise.reject(new Error("team roster unavailable: statement timeout"))),
      Promise.resolve(["top-edition"]),
      Promise.resolve({ rows: ["sale"], ok: true }),
      Promise.resolve(["set"]),
      Promise.resolve(["squeeze"]),
      Promise.resolve({ next: "game" }),
    ])
    expect(roster.ok).toBe(false)
    expect(topEditions).toEqual(["top-edition"])
    expect(activity).toEqual({ rows: ["sale"], ok: true })
    expect(sets).toEqual(["set"])
    expect(squeeze).toEqual(["squeeze"])
    expect(nextGame).toEqual({ next: "game" })
  })

  it("logs the section-level degradation with the thrown message, under the greppable prefix", async () => {
    await structuralSection("series editions", Promise.reject(new Error("canceling statement due to statement timeout")))
    const line = errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")
    expect(line).toContain("[entity-section]")
    expect(line).toContain("series editions")
    expect(line).toContain("canceling statement due to statement timeout")
    // ⚠ Names the DISPOSITION. Without it this line is indistinguishable in the
    // logs from the whole-page catch it replaced, and the rung is unfalsifiable.
    expect(line).toContain("degrading the SECTION")
  })

  it("a non-Error throw still reports rather than crashing the render", async () => {
    const res = await structuralSection("t", Promise.reject("a bare string"))
    expect(res.ok).toBe(false)
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).toContain("a bare string")
  })
})
