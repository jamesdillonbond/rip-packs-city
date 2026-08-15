import { describe, it, expect, vi } from "vitest"
import { rpcWithRetry, RPC_TIMEOUT_CODE } from "@/lib/analytics/rpc-with-retry"

// The abort branch of `withDeadline`, which NO other test in this repo reaches.
//
// `withDeadline` bounds an attempt two ways: `.abortSignal(AbortSignal.timeout)`
// on the builder, and a `Promise.race` guard. Every existing test mocks `.rpc`
// as a bare async function with no `.abortSignal`, so they all take the guard
// branch — and the guard is the branch that was already correct. In production
// the abort wins the race, and until 2026-08-15 it resolved the raw DOMException
// (`TimeoutError: The operation was aborted due to timeout`) with no SQLSTATE
// and no RPC_TIMEOUT code, defeating the whole point of exporting that code.
// That string is the Sentry title of JAVASCRIPT-NEXTJS-1Z and four siblings.
//
// These tests supply a mock that DOES implement `.abortSignal`, so the branch
// production actually takes is exercised.

/** A builder whose `.abortSignal()` arms the given failure mode. */
function abortingClient(mode: "reject" | "return" | "never", name = "TimeoutError") {
  const err = Object.assign(new Error("The operation was aborted due to timeout"), { name })
  const rpc = vi.fn(() => {
    const builder: Record<string, unknown> = {}
    builder.abortSignal = (signal: AbortSignal) =>
      new Promise((resolve, reject) => {
        if (mode === "never") return // let the race guard win
        signal.addEventListener("abort", () => {
          if (mode === "reject") reject(err)
          else resolve({ data: null, error: err })
        })
      })
    // Without .abortSignal being CALLED the promise never exists; withDeadline
    // calls it, so the returned builder itself is a thenable that never settles.
    builder.then = () => {}
    return builder
  })
  return { rpc } as never
}

describe("rpcWithRetry — the abort branch produces the same timeout shape as the guard", () => {
  it("normalizes an abort RETURNED as an error into RPC_TIMEOUT", async () => {
    const { data, error } = await rpcWithRetry(abortingClient("return"), "get_pack_detail_bundle", {}, {
      timeoutMs: 20,
      attempts: 1,
    })
    expect(data).toBeNull()
    expect(error?.code).toBe(RPC_TIMEOUT_CODE)
    // ⚠ The load-bearing assertion: the driver's own DOMException wording must
    // not be what escapes. It is meaningless to a reader and it is what made
    // five Sentry issues title themselves after a browser API.
    expect(error?.message).not.toContain("The operation was aborted")
    expect(error?.message).toContain("get_pack_detail_bundle")
    expect(error?.message).toContain("timed out")
  })

  it("normalizes an abort thrown as a REJECTION instead of letting it escape", async () => {
    // Before the fix this rejected out of rpcWithRetry entirely, past every
    // caller that destructures { data, error } — a contract break, not a
    // wording difference. `fetchPackDetailBundle` would never have returned.
    const call = rpcWithRetry(abortingClient("reject"), "get_edition_detail", {}, {
      timeoutMs: 20,
      attempts: 1,
    })
    await expect(call).resolves.toMatchObject({ data: null, error: { code: RPC_TIMEOUT_CODE } })
  })

  it("treats an explicit AbortError the same as a TimeoutError", async () => {
    const { error } = await rpcWithRetry(abortingClient("reject", "AbortError"), "get_set_detail", {}, {
      timeoutMs: 20,
      attempts: 1,
    })
    expect(error?.code).toBe(RPC_TIMEOUT_CODE)
  })

  it("still settles via the race guard when the client has no abortSignal", async () => {
    // The pre-existing path, pinned so the normalization cannot regress it:
    // both mechanisms must yield ONE shape.
    const client = { rpc: () => new Promise(() => {}) } as never
    const { error } = await rpcWithRetry(client, "get_player_detail", {}, { timeoutMs: 20, attempts: 1 })
    expect(error?.code).toBe(RPC_TIMEOUT_CODE)
    expect(error?.message).toContain("get_player_detail")
  })

  it("does NOT swallow a non-abort rejection", async () => {
    // Folding every throw into `error` would hide genuine programming faults
    // behind a plausible "timed out" story.
    const boom = new Error("client.rpc is not a function")
    const client = { rpc: () => Promise.reject(boom) } as never
    await expect(rpcWithRetry(client, "get_team_detail", {}, { timeoutMs: 50, attempts: 1 })).rejects.toThrow(
      "client.rpc is not a function",
    )
  })

  it("a real, fast response is unaffected", async () => {
    const client = { rpc: async () => ({ data: [{ id: 1 }], error: null }) } as never
    const { data, error } = await rpcWithRetry(client, "get_pack_detail_bundle", {}, { timeoutMs: 500 })
    expect(error).toBeNull()
    expect(data).toEqual([{ id: 1 }])
  })
})
