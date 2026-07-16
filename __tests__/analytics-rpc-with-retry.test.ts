import { describe, it, expect, vi } from "vitest"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

// Unit tests for lib/analytics/rpc-with-retry.ts — the wrapper every
// /api/analytics/* route uses. It must retry connection-class (transient)
// errors with backoff but NEVER retry logic-class (42xxx) errors, and it must
// stop as soon as it succeeds or exhausts its attempt budget. Backoff is
// exercised with baseDelayMs:1 so the suite stays fast.

type Resp = { data?: unknown; error?: unknown }

// Build a fake Supabase client whose .rpc() returns the queued responses in
// order. Returns the client plus the spy so tests can assert call counts.
function fakeClient(responses: Resp[]) {
  const rpc = vi.fn()
  for (const r of responses) {
    rpc.mockResolvedValueOnce({ data: r.data ?? null, error: r.error ?? null })
  }
  return { client: { rpc } as any, rpc }
}

const ok = (data: unknown): Resp => ({ data, error: null })
const err = (code: string, message = ""): Resp => ({ error: { code, message } })
const msgErr = (message: string): Resp => ({ error: { message } })

describe("rpcWithRetry", () => {
  it("returns data on first success without retrying", async () => {
    const { client, rpc } = fakeClient([ok({ rows: 3 })])
    const res = await rpcWithRetry(client, "some_fn", { a: 1 }, { baseDelayMs: 1 })
    expect(res).toEqual({ data: { rows: 3 }, error: null })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith("some_fn", { a: 1 })
  })

  it("coalesces undefined success data to null", async () => {
    const { client } = fakeClient([{ data: undefined, error: null }])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res).toEqual({ data: null, error: null })
  })

  it("retries a transient SQLSTATE then returns the eventual success", async () => {
    const { client, rpc } = fakeClient([err("53300", "too many connections"), ok({ v: 1 })])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toEqual({ v: 1 })
    expect(res.error).toBeNull()
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("treats any 08xxx code as transient", async () => {
    const { client, rpc } = fakeClient([err("08004"), ok("recovered")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("recovered")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("treats network-y messages with no code as transient", async () => {
    const { client, rpc } = fakeClient([msgErr("fetch failed"), ok("ok")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBe("ok")
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it("never retries a logic-class (42xxx) error", async () => {
    const { client, rpc } = fakeClient([
      err("42883", "function does not exist"),
      ok("should-not-reach"),
    ])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ code: "42883" })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("does not retry an unknown non-transient error", async () => {
    const { client, rpc } = fakeClient([err("23505", "duplicate key"), ok("nope")])
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.error).toMatchObject({ code: "23505" })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("stops after exhausting the attempt budget on a persistent transient error", async () => {
    const { client, rpc } = fakeClient([err("57P01"), err("57P01"), err("57P01")])
    const res = await rpcWithRetry(client, "f", {}, { attempts: 3, baseDelayMs: 1 })
    expect(res.data).toBeNull()
    expect(res.error).toMatchObject({ code: "57P01" })
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it("honors a custom attempts count and the minimum-1 clamp", async () => {
    const { client, rpc } = fakeClient([err("08006"), err("08006"), err("08006"), err("08006"), err("08006")])
    await rpcWithRetry(client, "f", {}, { attempts: 5, baseDelayMs: 1 })
    expect(rpc).toHaveBeenCalledTimes(5)

    const { client: c2, rpc: r2 } = fakeClient([err("08006")])
    await rpcWithRetry(c2, "f", {}, { attempts: 0, baseDelayMs: 1 })
    expect(r2).toHaveBeenCalledTimes(1) // clamped up to 1
  })
})
