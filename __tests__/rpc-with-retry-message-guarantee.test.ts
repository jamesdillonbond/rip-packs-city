import { describe, it, expect, vi } from "vitest"
import { PostgrestError } from "@supabase/supabase-js"
import { rpcWithRetry, queryWithRetry, RPC_TIMEOUT_CODE } from "@/lib/analytics/rpc-with-retry"

// rpcWithRetry / queryWithRetry must never return an error whose `message` is
// missing or empty. Production logged `[edition] get_edition_detail error
// undefined` (2026-10-12, /nfl-all-day/edition/2527): supabase-js handed back an
// error object with no message, the page logged `error.message`, and the only
// record of the failure was the word "undefined". These tests pin the absence of
// that false-empty record, and that a message-bearing error is left alone.

function clientReturning(error: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data: null, error })
  return { client: { rpc } as any, rpc }
}

describe("rpcWithRetry — every returned error carries a message", () => {
  it("fills a MISSING message from the code/details/hint and names the RPC", async () => {
    const { client } = clientReturning({ code: "PGRST000", details: "upstream 502", hint: null })
    const res = await rpcWithRetry(client, "get_edition_detail", {}, { baseDelayMs: 1, attempts: 1 })
    expect(res.data).toBeNull()
    expect(typeof res.error?.message).toBe("string")
    expect(res.error!.message).not.toMatch(/undefined/)
    expect(res.error!.message).toContain("get_edition_detail")
    expect(res.error!.message).toContain("code=PGRST000")
    expect(res.error!.message).toContain("details=upstream 502")
    // the original fields survive — callers keying on .code keep working
    expect((res.error as any).code).toBe("PGRST000")
  })

  it("fills an EMPTY-STRING message too", async () => {
    const { client } = clientReturning({ code: "", message: "", details: "", hint: "" })
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1, attempts: 1 })
    expect(res.error!.message.trim()).not.toBe("")
    expect(res.error!.message).toContain("rpc f failed with no error message")
  })

  it("falls back to the object's JSON when it carries no known field", async () => {
    const { client } = clientReturning({ weird: 42 })
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1, attempts: 1 })
    expect(res.error!.message).toContain('"weird":42')
  })

  it("survives an object that cannot be JSON-serialised", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const { client } = clientReturning(cyclic)
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1, attempts: 1 })
    expect(res.error!.message).toContain("rpc f failed with no error message")
  })

  it("keeps a real PostgrestError a PostgrestError, and does not mutate the caller's object", async () => {
    const original = new PostgrestError({ message: "", details: "", hint: "", code: "PGRST000" })
    const { client } = clientReturning(original)
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1, attempts: 1 })
    expect(res.error).toBeInstanceOf(PostgrestError)
    expect(typeof (res.error as any).toJSON).toBe("function")
    expect(res.error!.message).toContain("code=PGRST000")
    expect(original.message).toBe("")
  })

  it("returns a message-bearing error as the SAME object, unchanged", async () => {
    const original = { code: "42883", message: "function does not exist", details: "", hint: "" }
    const { client } = clientReturning(original)
    const res = await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(res.error).toBe(original)
  })

  it("does not alter the RPC_TIMEOUT shape our own bound produces", async () => {
    const rpc = vi.fn().mockImplementation(() => new Promise(() => {}))
    const res = await rpcWithRetry({ rpc } as any, "slow_fn", {}, { timeoutMs: 20 })
    expect(res.error?.code).toBe(RPC_TIMEOUT_CODE)
    expect(res.error?.message).toBe("rpc slow_fn timed out after 20ms with no response")
  })

  it("still classifies the ORIGINAL error: a message-less non-transient error is not retried", async () => {
    const { client, rpc } = clientReturning({ code: "42P01" })
    await rpcWithRetry(client, "f", {}, { baseDelayMs: 1 })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it("leaves a SUCCESS untouched (null error stays null)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: 1 }, error: null })
    const res = await rpcWithRetry({ rpc } as any, "f", {}, { baseDelayMs: 1 })
    expect(res).toEqual({ data: { ok: 1 }, error: null })
  })
})

describe("queryWithRetry — same guarantee on the table-read path", () => {
  it("fills a missing message and names the label", async () => {
    const build = vi.fn().mockImplementation(() => Promise.resolve({ data: null, error: { code: "PGRST000" } }))
    const res = await queryWithRetry(build, "editions read", { baseDelayMs: 1, attempts: 1 })
    expect(res.error!.message).toContain("editions read")
    expect(res.error!.message).toContain("code=PGRST000")
  })
})
