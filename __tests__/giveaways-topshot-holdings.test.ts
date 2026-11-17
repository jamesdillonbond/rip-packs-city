import { describe, it, expect, vi } from "vitest"
import { readFileSync } from "node:fs"
import { FLOW_SCRIPTS_URL, readTopShotHoldings, TOPSHOT_LOCK_SCRIPT } from "@/lib/giveaways/topshot-holdings"

function flowResponse(entries: Array<[string, boolean]>, type = "Dictionary") {
  const json = { type, value: entries.map(([k, v]) => ({ key: { type: "UInt64", value: k }, value: { type: "Bool", value: v } })) }
  return new Response(JSON.stringify(Buffer.from(JSON.stringify(json)).toString("base64")) + "\n", { status: 200 })
}

describe("giveaways/topshot-holdings", () => {
  it("the Cadence is byte-identical to the production lock-check script", () => {
    const route = readFileSync("app/api/cron/lock-check-batch/route.ts", "utf8")
    const m = route.match(/const TOPSHOT_LOCK_SCRIPT = `([\s\S]*?)`\.trim\(\)/)
    expect(m, "lock-check-batch no longer defines TOPSHOT_LOCK_SCRIPT the same way").not.toBeNull()
    expect(TOPSHOT_LOCK_SCRIPT).toBe(m![1].trim())
    expect(route).toContain(FLOW_SCRIPTS_URL)
  })

  it("held = key present; locked = its value; absent ids are not held", async () => {
    const fetchImpl = vi.fn(async () => flowResponse([["1", false], ["2", true]]))
    const out = await readTopShotHoldings("0x00000000000000aa", ["1", "2", "3"], fetchImpl)
    expect(out).toEqual({
      "1": { held: true, locked: false },
      "2": { held: true, locked: true },
      "3": { held: false, locked: null },
    })
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(Buffer.from(body.script, "base64").toString()).toBe(TOPSHOT_LOCK_SCRIPT)
    expect(JSON.parse(Buffer.from(body.arguments[0], "base64").toString())).toEqual({ type: "Address", value: "0x00000000000000aa" })
  })

  it("reads in chunks of 50", async () => {
    const fetchImpl = vi.fn(async () => flowResponse([]))
    const ids = Array.from({ length: 120 }, (_, i) => String(i + 1))
    await readTopShotHoldings("0x00000000000000aa", ids, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it("never returns a partial answer: a failed chunk throws", async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => (++n === 2 ? new Response("boom", { status: 500 }) : flowResponse([["1", false]])))
    const ids = Array.from({ length: 60 }, (_, i) => String(i + 1))
    await expect(readTopShotHoldings("0x00000000000000aa", ids, fetchImpl)).rejects.toThrow(/HTTP 500/)
  })

  it("throws on an undecodable or unexpected body", async () => {
    await expect(readTopShotHoldings("0x00000000000000aa", ["1"], async () => new Response('"!!notbase64json"'))).rejects.toThrow(/undecodable/)
    await expect(readTopShotHoldings("0x00000000000000aa", ["1"], async () => flowResponse([], "Array"))).rejects.toThrow(/unexpected shape/)
  })

  it("refuses a malformed address or id before any network call", async () => {
    const fetchImpl = vi.fn()
    await expect(readTopShotHoldings("0xABC", ["1"], fetchImpl)).rejects.toThrow(/Flow address/)
    await expect(readTopShotHoldings("0x00000000000000aa", ["1a"], fetchImpl)).rejects.toThrow(/moment id/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
