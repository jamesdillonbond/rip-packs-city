import { describe, it, expect, vi } from "vitest"
import { canSignAlone, planSwap, readActiveKeyWeights, swapArgs, SwapTestError, validateSwapInput } from "@/lib/swap-test/plan"
import { PROVIDER_CONTROLLERS_SCRIPT } from "@/lib/giveaways/deliver-cadence"
import { SWAP_SIMULATION_SCRIPT } from "@/lib/swap-test/swap-cadence"
import type { CdcValue } from "@/lib/giveaways/flow-script"

const A = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac", ids: ["27289790"] }
const B = { signer: "0xd96dc67ae64ee202", source: "0xd96dc67ae64ee202", ids: [] as string[] }

const arr = (type: string, values: unknown[]): CdcValue => ({ type: "Array", value: values.map((value) => ({ type, value })) })

function deps(over: { sim?: boolean[]; controllers?: string[]; held?: boolean; locked?: boolean | null; readThrows?: boolean; weights?: Record<string, number[]>; keysThrow?: boolean } = {}) {
  const run = vi.fn(async (script: string, _args: unknown[]) => {
    if (script === PROVIDER_CONTROLLERS_SCRIPT) return arr("UInt64", over.controllers ?? ["87", "4"])
    if (script === SWAP_SIMULATION_SCRIPT) return arr("Bool", over.sim ?? [true])
    throw new Error("unexpected script")
  })
  const read = vi.fn(async (_addr: string, ids: string[]) => {
    if (over.readThrows) throw new Error("Flow script HTTP 503")
    return Object.fromEntries(ids.map((id) => [id, { held: over.held ?? true, locked: over.held === false ? null : "locked" in over ? (over.locked as boolean | null) : false }]))
  })
  const keys = vi.fn(async (addr: string) => {
    if (over.keysThrow) throw new Error("Flow account read HTTP 503")
    return over.weights?.[addr] ?? [1000, 1000, 1000]
  })
  return { run, read, keys }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof SwapTestError ? `${e.status}:${e.code}` : `other:${String(e)}`
  }
  return "resolved"
}

describe("swap-test/plan — validation", () => {
  it("accepts Trevor's first run and lowercases addresses", () => {
    const v = validateSwapInput({ ...A, signer: A.signer.toUpperCase().replace("0X", "0x") }, B)
    expect(v.a.signer).toBe(A.signer)
    expect(v.b.ids).toEqual([])
  })

  it.each([
    ["two different signers", { ...B, signer: A.signer }, "same_signer"],
    ["two different sources", { ...B, source: A.source }, "same_source"],
    ["something to swap", { ...B }, null],
  ])("requires %s", (_n, b, code) => {
    if (code) expect(() => validateSwapInput(A, b)).toThrow(expect.objectContaining({ code }))
    else expect(() => validateSwapInput({ ...A, ids: [] }, b)).toThrow(expect.objectContaining({ code: "empty" }))
  })

  it("refuses malformed input with a 400, never a chain read", () => {
    for (const [a, code] of [
      [{ ...A, signer: "3d0b274c80263484" }, "bad_signer"],
      [{ ...A, source: "not-an-address" }, "bad_source"],
      [{ ...A, ids: ["12x"] }, "bad_id"],
      [{ ...A, ids: ["1", "1"] }, "duplicate_id"],
      [{ ...A, ids: Array.from({ length: 11 }, (_, i) => String(i + 1)) }, "too_many"],
    ] as const) {
      expect(() => validateSwapInput(a, B)).toThrow(expect.objectContaining({ code, status: 400 }))
    }
  })
})

describe("swap-test/plan — planning against the chain", () => {
  it("plans a linked side through its first resolvable controller and an own side with ctl 0, then simulates it", async () => {
    const d = deps()
    const plan = await planSwap(A, B, d)
    expect(plan.a).toMatchObject({ kind: "linked", ctl: "87" })
    expect(plan.b).toMatchObject({ kind: "own", ctl: "0" })
    const simCall = d.run.mock.calls.find((c) => c[0] === SWAP_SIMULATION_SCRIPT)!
    expect(simCall[1]).toEqual([
      { type: "Address", value: A.signer },
      { type: "Address", value: B.signer },
      ...swapArgs(plan),
    ])
    // the own side gives nothing: no holdings read for it
    expect(d.read).toHaveBeenCalledTimes(1)
  })

  it("never asks a wallet to sign a swap whose simulation did not land every moment", async () => {
    expect(await codeOf(planSwap(A, B, deps({ sim: [false] })))).toBe("409:simulation_failed")
    // a short result is a failure too, not a pass on the moments it did report
    expect(await codeOf(planSwap(A, { ...B, ids: [] }, deps({ sim: [] })))).toBe("409:simulation_failed")
  })

  it("names a moment the source does not hold, or one locked on chain", async () => {
    expect(await codeOf(planSwap(A, B, deps({ held: false })))).toBe("409:not_held")
    expect(await codeOf(planSwap(A, B, deps({ locked: true })))).toBe("409:locked")
    // lock state unknown is not "unlocked"
    expect(await codeOf(planSwap(A, B, deps({ locked: null })))).toBe("409:locked")
  })

  it("a failed chain read is a retryable 502, never 'not held'", async () => {
    expect(await codeOf(planSwap(A, B, deps({ readThrows: true })))).toBe("502:chain_read_failed")
  })

  it("a signer that cannot withdraw from the linked source is refused", async () => {
    expect(await codeOf(planSwap(A, B, deps({ controllers: [] })))).toBe("409:not_parent")
  })
})

describe("swap-test/plan — can each signer sign on its own?", () => {
  it("needs one active full-weight key; a 999 + 1 split (Blocto-style) cannot sign alone", () => {
    expect(canSignAlone([1000])).toBe(true)
    expect(canSignAlone([999, 1])).toBe(false)
    expect(canSignAlone([])).toBe(false)
    expect(canSignAlone([Number.NaN])).toBe(false)
  })

  it("refuses a signer with no full-weight key before any simulation", async () => {
    const d = deps({ weights: { [B.signer]: [999, 1] } })
    expect(await codeOf(planSwap(A, B, d))).toBe("409:cannot_sign_alone")
    expect(d.run.mock.calls.some((c) => c[0] === SWAP_SIMULATION_SCRIPT)).toBe(false)
  })

  it("a failed key read is a retryable 502, never 'cannot sign'", async () => {
    expect(await codeOf(planSwap(A, B, deps({ keysThrow: true })))).toBe("502:chain_read_failed")
  })

  it("reads ACTIVE key weights only (0xd96d… on 2026-10-04: revoked 1000 + 1 ignored)", async () => {
    const body = {
      keys: [
        { index: "0", weight: "999", revoked: false },
        { index: "1", weight: "1000", revoked: true },
        { index: "2", weight: "1", revoked: true },
        { index: "3", weight: "1000", revoked: false },
        { index: "4", weight: "1", revoked: false },
      ],
    }
    const f = vi.fn<(url: string) => Promise<Response>>(async () => new Response(JSON.stringify(body), { status: 200 }))
    expect(await readActiveKeyWeights("0xd96dc67ae64ee202", f as never)).toEqual([999, 1000, 1])
    expect(String(f.mock.calls[0][0])).toBe("https://rest-mainnet.onflow.org/v1/accounts/0xd96dc67ae64ee202?expand=keys")
    await expect(readActiveKeyWeights("0x1", (async () => new Response("x", { status: 500 })) as never)).rejects.toThrow("HTTP 500")
    await expect(readActiveKeyWeights("0x1", (async () => new Response("{}", { status: 200 })) as never)).rejects.toThrow("no key list")
  })
})
