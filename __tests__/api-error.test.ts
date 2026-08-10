import { describe, it, expect } from "vitest"
import { safeApiError, statusForSafeError } from "@/lib/api-error"

// deep-audit D3. The rule this pins: a driver message never reaches a response
// body. /api/sets returned err.message, the sets page renders body.error verbatim
// under an "ERROR" heading, and under disk-IO saturation that put
// "canceling statement due to statement timeout" on the flagship Top Shot Set
// Tracker for anonymous visitors.

describe("safeApiError", () => {
  it("classifies a PostgrestError statement timeout by SQLSTATE", () => {
    const e = safeApiError({ code: "57014", message: "canceling statement due to statement timeout" })
    expect(e.code).toBe("timeout")
    expect(e.retryable).toBe(true)
  })

  it("never echoes the driver text on any branch", () => {
    const inputs: unknown[] = [
      { code: "57014", message: "canceling statement due to statement timeout" },
      new Error("canceling statement due to statement timeout"),
      { code: "42P01", message: 'relation "mv_topshot_secret_board" does not exist' },
      new Error("Timed out acquiring connection from connection pool"),
      { message: "duplicate key value violates unique constraint sales_2026_pkey" },
      "a bare string",
      null,
    ]
    for (const input of inputs) {
      const out = safeApiError(input)
      expect(out.error).not.toMatch(/canceling statement/i)
      expect(out.error).not.toMatch(/relation "/i)
      expect(out.error).not.toMatch(/mv_topshot_secret_board/i)
      expect(out.error).not.toMatch(/sales_2026_pkey/i)
      expect(out.error).not.toMatch(/connection pool/i)
    }
  })

  it("still catches a timeout that arrives with no SQLSTATE", () => {
    // Not every path preserves `code` — a rethrown Error keeps only the text.
    expect(safeApiError(new Error("canceling statement due to statement timeout")).code).toBe("timeout")
    expect(safeApiError(new Error("Timed out acquiring connection from connection pool")).code).toBe("timeout")
  })

  it("reports a missing relation/function as unavailable, not as the caller's fault", () => {
    expect(safeApiError({ code: "42P01", message: 'relation "x" does not exist' }).code).toBe("unavailable")
    expect(safeApiError({ code: "42883", message: "function y does not exist" }).code).toBe("unavailable")
  })

  it("defaults to the caller's fallback for anything unrecognized", () => {
    const e = safeApiError({ code: "23505", message: "duplicate key" }, "Failed to load sets.")
    expect(e.code).toBe("internal")
    expect(e.error).toBe("Failed to load sets.")
    expect(e.retryable).toBe(false)
  })

  it("survives junk input instead of throwing inside the catch block", () => {
    // This runs INSIDE a catch. If it throws, the route 500s with a stack.
    for (const junk of [null, undefined, 0, "", [], { message: 42 }, { code: 7 }]) {
      expect(() => safeApiError(junk)).not.toThrow()
      expect(typeof safeApiError(junk).error).toBe("string")
    }
  })

  it("maps a timeout to 503 so it stays out of the hard-5xx budget", () => {
    expect(statusForSafeError(safeApiError({ code: "57014" }))).toBe(503)
    expect(statusForSafeError(safeApiError({ code: "23505" }))).toBe(500)
  })

  it("gives the user an action rather than a diagnosis", () => {
    expect(safeApiError({ code: "57014" }).error).toMatch(/try again/i)
  })
})
