// The recent-buys sync (2026-11-10, spitehouse 5 of 6): a purchase made after
// the wallet's last walk reaches the cache ONLY when the chain says it is held,
// and a failed read never writes or reads as "nothing new".
import { describe, it, expect, vi } from "vitest"
import { syncRecentTopShotBuys, type RpcClient } from "@/lib/trophy/recent-buys"

const WALLET = "0x9b0079c2c8f0ccc9"

function chainSays(heldLocked: Record<string, boolean>) {
  const dict = {
    type: "Dictionary",
    value: Object.entries(heldLocked).map(([id, locked]) => ({
      key: { type: "UInt64", value: id },
      value: { type: "Bool", value: locked },
    })),
  }
  const body = JSON.stringify(Buffer.from(JSON.stringify(dict), "utf8").toString("base64"))
  return vi.fn(async () => new Response(body, { status: 200 }))
}

function db(candidates: unknown, recordResult: unknown = { data: 1, error: null }) {
  const rpc = vi.fn(async (name: string, _args: unknown) => {
    if (name === "get_unwalked_topshot_buys") return candidates
    if (name === "record_verified_topshot_buys") return recordResult
    throw new Error(`unexpected rpc ${name}`)
  })
  return { rpc } as unknown as RpcClient & { rpc: typeof rpc }
}

describe("syncRecentTopShotBuys", () => {
  it("records only the candidates the chain says are held, with their lock state", async () => {
    const d = db({ data: [{ moment_id: "14478982" }, { moment_id: "51757607" }, { moment_id: "999" }], error: null }, { data: 2, error: null })
    const fetchImpl = chainSays({ "14478982": false, "51757607": true })
    const r = await syncRecentTopShotBuys(d, WALLET, fetchImpl)
    expect(r).toEqual({ wallet: WALLET, candidates: 3, held: 2, added: 2, error: null })
    const rec = d.rpc.mock.calls.find((c) => c[0] === "record_verified_topshot_buys")!
    expect(rec[1]).toEqual({ p_wallet: WALLET, p_held_ids: ["14478982", "51757607"], p_locked_ids: ["51757607"] })
  })

  it("writes nothing when the chain holds none of the candidates (resold / gifted)", async () => {
    const d = db({ data: [{ moment_id: "14478982" }], error: null })
    const r = await syncRecentTopShotBuys(d, WALLET, chainSays({}))
    expect(r.held).toBe(0)
    expect(r.added).toBe(0)
    expect(d.rpc.mock.calls.some((c) => c[0] === "record_verified_topshot_buys")).toBe(false)
  })

  it("a failed chain read writes nothing and reports an error, never a clean zero", async () => {
    const d = db({ data: [{ moment_id: "14478982" }], error: null })
    const r = await syncRecentTopShotBuys(d, WALLET, vi.fn(async () => new Response("", { status: 503 })))
    expect(r.error).toMatch(/503/)
    expect(d.rpc.mock.calls.some((c) => c[0] === "record_verified_topshot_buys")).toBe(false)
  })

  it("a failed candidate read reports an error", async () => {
    const d = db({ data: null, error: { message: "boom" } })
    const r = await syncRecentTopShotBuys(d, WALLET, chainSays({}))
    expect(r.error).toMatch(/boom/)
  })

  it("a failed record write reports an error and added stays 0", async () => {
    const d = db({ data: [{ moment_id: "14478982" }], error: null }, { data: null, error: { message: "nope" } })
    const r = await syncRecentTopShotBuys(d, WALLET, chainSays({ "14478982": false }))
    expect(r.error).toMatch(/nope/)
    expect(r.added).toBe(0)
  })

  it("skips a non-Flow address without touching the DB", async () => {
    const d = db({ data: [], error: null })
    const r = await syncRecentTopShotBuys(d, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", chainSays({}))
    expect(r.error).toBeNull()
    expect(d.rpc).not.toHaveBeenCalled()
  })
})
