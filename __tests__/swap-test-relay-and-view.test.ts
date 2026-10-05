import { describe, it, expect, vi } from "vitest"
import { checkSignable, getRelay, isExpired, postSignable, postSignature, RELAY_KEEP_MS, RELAY_TTL_MS } from "@/lib/swap-test/relay"
import { describeSignable, parseIds, waitForRelaySignature } from "@/lib/swap-test/view"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"

const B = "0xd96dc67ae64ee202"
const SIG = "ab".repeat(64)
const ID = "11111111-2222-4333-8444-555555555555"
const args = [
  { type: "Address", value: "0xbd94cade097e50ac" },
  { type: "UInt64", value: "87" },
  { type: "Array", value: [{ type: "UInt64", value: "27289790" }] },
  { type: "Address", value: B },
  { type: "UInt64", value: "0" },
  { type: "Array", value: [] },
]
const signable = { cadence: SWAP_CADENCE, message: "deadbeef", addr: B.slice(2), keyId: 0, args }

describe("swap-test/relay — only the swap transaction travels", () => {
  it("accepts wallet B's signable for the swap", () => {
    expect(checkSignable(B, signable)).toBe(signable)
  })

  it("refuses any other Cadence, a signable for another account, or no payload", () => {
    expect(() => checkSignable(B, { ...signable, cadence: "transaction { execute { } }" })).toThrow(expect.objectContaining({ code: "wrong_cadence" }))
    expect(() => checkSignable(B, { ...signable, addr: "3d0b274c80263484" })).toThrow(expect.objectContaining({ code: "wrong_signer" }))
    expect(() => checkSignable(B, { ...signable, message: "" })).toThrow(expect.objectContaining({ code: "bad_signable" }))
    expect(() => checkSignable("d96dc67ae64ee202", signable)).toThrow(expect.objectContaining({ code: "bad_cosigner" }))
    expect(() => checkSignable(B, null)).toThrow(expect.objectContaining({ code: "bad_signable" }))
  })

  it("expires after the TTL, and an unreadable timestamp counts as expired", () => {
    const t0 = Date.parse("2026-10-03T12:00:00Z")
    expect(isExpired("2026-10-03T12:00:00Z", t0 + RELAY_TTL_MS)).toBe(false)
    expect(isExpired("2026-10-03T12:00:00Z", t0 + RELAY_TTL_MS + 1)).toBe(true)
    expect(isExpired("garbage", t0)).toBe(true)
  })
})

function fakeDb(row: Record<string, unknown> | null, updated: unknown[] = [{ id: ID }]) {
  const update = vi.fn(() => chain)
  const chain: Record<string, unknown> = {}
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    is: vi.fn(() => chain),
    update,
    maybeSingle: async () => ({ data: row, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: updated, error: null }),
  })
  return { db: { from: () => chain } as never, update, chain }
}

describe("swap-test/relay — storing a request", () => {
  function storeDb(cleanupError: { message: string } | null) {
    const calls: string[] = []
    const lt = vi.fn(async () => ({ error: cleanupError }))
    const db = {
      from: () => ({
        delete: () => (calls.push("delete"), { lt }),
        insert: (row: unknown) => (calls.push("insert"), { select: () => ({ single: async () => ({ data: { id: ID, row }, error: null }) }) }),
      }),
    }
    return { db: db as never, lt, calls }
  }
  const now = Date.parse("2026-10-04T12:00:00Z")

  it("removes rows older than a day, then stores the request", async () => {
    const f = storeDb(null)
    expect(await postSignable(f.db, B, signable, now)).toBe(ID)
    expect(f.calls).toEqual(["delete", "insert"])
    expect(f.lt).toHaveBeenCalledWith("created_at", new Date(now - RELAY_KEEP_MS).toISOString())
  })

  it("a failed cleanup is logged and never blocks the swap", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const f = storeDb({ message: "permission denied" })
    expect(await postSignable(f.db, B, signable, now)).toBe(ID)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cleanup"), "permission denied")
    warn.mockRestore()
  })

  it("refuses a non-swap signable before touching the table", async () => {
    const f = storeDb(null)
    await expect(postSignable(f.db, B, { ...signable, cadence: "x" }, now)).rejects.toMatchObject({ code: "wrong_cadence" })
    expect(f.calls).toEqual([])
  })
})

describe("swap-test/relay — signatures", () => {
  const fresh = { id: ID, cosigner: B, signable, signature: null, key_id: null, created_at: "2026-10-03T12:00:00Z", signed_at: null }
  const now = Date.parse("2026-10-03T12:01:00Z")

  it("stores a 64-byte signature with its key, only on an unsigned relay", async () => {
    const f = fakeDb(fresh)
    await postSignature(f.db, ID, `0x${SIG.toUpperCase()}`, 2, now)
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ signature: SIG, key_id: 2 }))
    expect(f.chain.is).toHaveBeenCalledWith("signature", null)
  })

  it("never overwrites an existing signature", async () => {
    const f = fakeDb(fresh, [])
    await expect(postSignature(f.db, ID, SIG, 0, now)).rejects.toMatchObject({ code: "already_signed" })
  })

  it("refuses a malformed signature or key before touching the row", async () => {
    const f = fakeDb(fresh)
    await expect(postSignature(f.db, ID, "abc", 0, now)).rejects.toMatchObject({ code: "bad_signature" })
    await expect(postSignature(f.db, ID, SIG, -1, now)).rejects.toMatchObject({ code: "bad_key" })
    expect(f.update).not.toHaveBeenCalled()
  })

  it("an expired or unknown relay is an error, not an empty one", async () => {
    await expect(getRelay(fakeDb(fresh).db, ID, now + RELAY_TTL_MS)).rejects.toMatchObject({ status: 410 })
    await expect(getRelay(fakeDb(null).db, ID, now)).rejects.toMatchObject({ status: 404 })
    await expect(getRelay(fakeDb(fresh).db, "nope", now)).rejects.toMatchObject({ status: 400 })
  })
})

describe("swap-test/view", () => {
  it("parses id fields", () => {
    expect(parseIds(" 1, 2  3,,")).toEqual(["1", "2", "3"])
    expect(parseIds("")).toEqual([])
  })

  it("describes what B signs from the signable's OWN arguments", () => {
    expect(describeSignable(signable)).toEqual({ ok: true, sourceA: "0xbd94cade097e50ac", idsA: ["27289790"], sourceB: B, idsB: [] })
  })

  it("tells the co-signer not to sign anything else", () => {
    expect(describeSignable({ ...signable, cadence: "transaction {}" })).toMatchObject({ ok: false })
    expect(describeSignable({ ...signable, args: args.slice(0, 5) })).toMatchObject({ ok: false })
    expect(describeSignable({ ...signable, args: [args[0], args[1], { type: "Array", value: [{ type: "String", value: "x" }] }, ...args.slice(3)] })).toMatchObject({ ok: false })
  })

  const sleep = async () => {}
  const unsigned = { ok: true, status: 200, body: { relay: { signature: null, key_id: null } } }
  const signed = { ok: true, status: 200, body: { relay: { signature: SIG, key_id: 1 } } }

  it("returns the signature once the co-signer has signed", async () => {
    const get = vi.fn().mockResolvedValueOnce(unsigned).mockResolvedValueOnce(signed)
    await expect(waitForRelaySignature(get, ID, sleep)).resolves.toEqual({ signature: SIG, keyId: 1 })
  })

  it("an expired relay rejects at once; it never reads as 'still unsigned'", async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, status: 410, body: { error: "expired" } })
    await expect(waitForRelaySignature(get, ID, sleep)).rejects.toThrow("expired")
    expect(get).toHaveBeenCalledTimes(1)
  })

  it("five failed reads in a row reject; one blip does not", async () => {
    const blip = { ok: false, status: 503, body: { error: "down" } }
    const recovering = vi.fn().mockResolvedValueOnce(blip).mockResolvedValueOnce(signed)
    await expect(waitForRelaySignature(recovering, ID, sleep)).resolves.toMatchObject({ keyId: 1 })
    const down = vi.fn().mockResolvedValue(blip)
    await expect(waitForRelaySignature(down, ID, sleep)).rejects.toThrow("5 reads")
  })

  it("runs out of attempts with an error, never a silent resolve", async () => {
    await expect(waitForRelaySignature(vi.fn().mockResolvedValue(unsigned), ID, sleep, 3)).rejects.toThrow("didn't sign in time")
  })
})
