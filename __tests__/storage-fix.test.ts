import { describe, it, expect, vi, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { NextRequest } from "next/server"
import {
  DAPPER_REFILL_BODY,
  DAPPER_REFILL_CADENCE,
  DAPPER_REFILL_SIMULATION,
  PLAIN_SEND_CADENCE,
  PLAIN_SEND_DEPOSIT,
  PLAIN_SEND_SIMULATION,
  PLAIN_SEND_WITHDRAW,
  STORAGE_FIX_CADENCES,
  STORAGE_STATE_SCRIPT,
} from "@/lib/storage-fix/cadence"
import {
  checkStorage,
  decodeState,
  findLastCapacityChange,
  parseFixAmount,
  simulateFix,
  planFix,
  StorageFixError,
  type StorageState,
} from "@/lib/storage-fix/check"
import { buildStorageFix } from "@/lib/storage-fix/wallet"
import { historyLine, verdict } from "@/lib/storage-fix/view"

// /admin/storage-fix (Trevor, 2026-11-05): an admin-only console that diagnoses a Flow
// account stuck on storage (error 1103) and sends the fix from the admin's Flow Wallet.
// Measured live the day it was built (read-only): Andrew Laird's 0x9124f9b74b02e86e was
// refilled 0.06 FLOW by Dapper's forwarder account at block 169,925,218 (Nov 3, 8:50 AM PT),
// two days before he asked publicly — the history search found exactly that block.

const ADDR = "0x9124f9b74b02e86e"
const DAPPER = "0x18eb4ee6b3c026d2"

describe("storage-fix/cadence — the only texts a wallet signs here", () => {
  it("the Dapper refill is BYTE-IDENTICAL to the transaction Trevor sealed eight times through run.flowty.io", () => {
    // sha256 of the script of his transaction 4d22f6d1… as read from rest-mainnet on 2026-11-05
    expect(createHash("sha256").update(DAPPER_REFILL_CADENCE).digest("hex")).toBe("d3d7f1cb7b1621f5acf6d62b4593af55c57a7cd64f05ff74db2133e70cb1b830")
    expect(DAPPER_REFILL_CADENCE).toContain("DapperStorageRent.fundedRefillV2(address: receiver")
    expect(DAPPER_REFILL_CADENCE).toContain("import DapperStorageRent from 0xa08e88e23f332538")
  })

  it("the plain send can only deposit into the receiver's own FLOW receiver, and reverts when there is none", () => {
    expect(PLAIN_SEND_CADENCE).toContain("transaction(receiver: Address, amount: UFix64)")
    expect(PLAIN_SEND_CADENCE).toContain("getAccount(receiver).capabilities.borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)")
    expect(PLAIN_SEND_CADENCE).toMatch(/\?\? panic\("The receiver has no FLOW receiver/)
    const imports = [...PLAIN_SEND_CADENCE.matchAll(/^import (\w+) from (0x[0-9a-f]+)$/gm)].map((m) => `${m[1]}@${m[2]}`)
    expect(imports).toEqual(["FungibleToken@0xf233dcee88fe0abe", "FlowToken@0x1654653399040a61"])
  })

  it("each simulation runs its transaction's OWN statements verbatim, as the operator, without committing", () => {
    expect(DAPPER_REFILL_CADENCE).toContain(DAPPER_REFILL_BODY)
    expect(DAPPER_REFILL_SIMULATION).toContain(DAPPER_REFILL_BODY)
    for (const frag of [PLAIN_SEND_WITHDRAW, PLAIN_SEND_DEPOSIT]) {
      expect(PLAIN_SEND_CADENCE).toContain(frag)
      expect(PLAIN_SEND_SIMULATION).toContain(frag)
    }
    for (const sim of [DAPPER_REFILL_SIMULATION, PLAIN_SEND_SIMULATION]) {
      expect(sim).toContain("access(all) fun main(signerAddr: Address, receiver: Address, amount: UFix64): [UInt64]")
      expect(sim).toContain("let signer = getAuthAccount<auth(BorrowValue) &Account>(signerAddr)")
      expect(sim).not.toMatch(/\btransaction\(/)
    }
  })

  it("exactly two signable texts, both taking (receiver, amount) in that order", () => {
    expect(STORAGE_FIX_CADENCES).toHaveLength(2)
    for (const c of STORAGE_FIX_CADENCES) expect(c).toContain("transaction(receiver: Address, amount: UFix64)")
  })
})

describe("storage-fix/wallet — buildStorageFix refuses before the wallet opens", () => {
  it("maps each kind to its pinned text and normalises the receiver", () => {
    expect(buildStorageFix({ kind: "dapper_refill", receiver: ADDR.toUpperCase().replace("0X", "0x"), amount: "0.01000000" })).toEqual({
      cadence: DAPPER_REFILL_CADENCE,
      receiver: ADDR,
      amount: "0.01000000",
    })
    expect(buildStorageFix({ kind: "plain_send", receiver: ADDR, amount: "0.10000000" }).cadence).toBe(PLAIN_SEND_CADENCE)
  })

  it("refuses an unknown kind, a non-Flow receiver and a malformed or zero amount", () => {
    expect(() => buildStorageFix({ kind: "other" as never, receiver: ADDR, amount: "0.01000000" })).toThrow(/Unknown fix/)
    expect(() => buildStorageFix({ kind: "dapper_refill", receiver: "0x123", amount: "0.01000000" })).toThrow(/not a Flow address/)
    for (const amount of ["0.01", "1e-2", "-0.01000000", "0.00000000", ""]) {
      expect(() => buildStorageFix({ kind: "dapper_refill", receiver: ADDR, amount }), amount).toThrow(/not a FLOW amount/)
    }
  })
})

const state = (o: Partial<StorageState> = {}): StorageState => ({
  usedBytes: 101_541,
  capacityBytes: 100_000,
  balanceFlow: 0.001,
  isDapperWallet: true,
  hasFlowReceiver: false,
  megabytesPerFlow: 100,
  ...o,
})

describe("storage-fix/check — planFix", () => {
  it("a stuck Dapper wallet gets the Dapper refill, rounded UP to leave at least 1 MB free", () => {
    // 1,541 bytes over + 1 MB of room = 1,001,541 bytes = 0.0100154 FLOW at 100 MB/FLOW → 0.02 (never 0.01, which would leave 998 KB)
    const p = planFix(state())
    expect(p).toMatchObject({ stuck: true, kind: "dapper_refill", amount: "0.02000000", addsBytes: 2_000_000, headroomBytes: -1_541 })
    expect(p.headroomBytes + (p.addsBytes ?? 0)).toBeGreaterThanOrEqual(1_000_000)
  })

  it("a non-Dapper account with a receiver gets a plain send — the Dapper refill would revert there", () => {
    expect(planFix(state({ isDapperWallet: false, hasFlowReceiver: true })).kind).toBe("plain_send")
  })

  it("an account with no way in is told so, with no amount offered", () => {
    expect(planFix(state({ isDapperWallet: false, hasFlowReceiver: false }))).toMatchObject({ kind: "none", amount: null })
  })

  it("an account with plenty of room is NOT stuck (Andrew's after Dapper's refill)", () => {
    expect(planFix(state({ usedBytes: 103_997, capacityBytes: 6_100_000, balanceFlow: 0.061 })).stuck).toBe(false)
  })

  it("never offers more than 1 FLOW, however far over an account is", () => {
    expect(planFix(state({ usedBytes: 900_000_000 })).amount).toBe("1.00000000")
  })

  it("parseFixAmount enforces the console's bounds", () => {
    expect(parseFixAmount("0.05")).toBe("0.05000000")
    for (const bad of ["0", "0.001", "2", "abc", ""]) expect(() => parseFixAmount(bad), bad).toThrow(StorageFixError)
  })
})

// ── a fake Flow REST API ─────────────────────────────────────────────────────

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64")
const cdcResponse = (v: unknown) => new Response(JSON.stringify(b64(v)), { status: 200 })
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status })

interface Chain {
  sealed: number
  capacityAt: (h: number) => number
  /** heights the API answers 404 for (before the spork root) */
  sporkRoot?: number
  /** a height whose script read fails with a 500 */
  failAt?: number
  simulation?: "ok" | "panic" | "error"
}

function fakeFlow(chain: Chain) {
  const calls: string[] = []
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(url)
    const u = new URL(url)
    if (u.pathname.endsWith("/scripts")) {
      const hs = u.searchParams.get("block_height")!
      const h = hs === "sealed" ? chain.sealed : Number(hs)
      if (chain.failAt === h) return new Response("boom", { status: 500 })
      if (chain.sporkRoot && h < chain.sporkRoot) return new Response("not found", { status: 404 })
      const body = JSON.parse(String(init?.body)) as { script: string }
      const script = Buffer.from(body.script, "base64").toString("utf8")
      if (script === DAPPER_REFILL_SIMULATION || script === PLAIN_SEND_SIMULATION) {
        if (chain.simulation === "panic") {
          return new Response('{"code":400,"message":"... panic: Could not borrow reference to private forwarder\\n  --> 18eb4ee6b3c026d2"}', { status: 400 })
        }
        if (chain.simulation === "error") return new Response("bad gateway", { status: 502 })
        return cdcResponse({ type: "Array", value: [{ type: "UInt64", value: "6100000" }, { type: "UInt64", value: "8100000" }] })
      }
      if (script === STORAGE_STATE_SCRIPT) {
        return cdcResponse({
          type: "Array",
          value: [
            { type: "UInt64", value: "103997" },
            { type: "UInt64", value: String(chain.capacityAt(h)) },
            { type: "Optional", value: { type: "UFix64", value: "0.06100000" } },
            { type: "Bool", value: true },
            { type: "Bool", value: false },
            { type: "UFix64", value: "100.00000000" },
          ],
        })
      }
      return cdcResponse({ type: "UInt64", value: String(chain.capacityAt(h)) })
    }
    if (u.pathname.endsWith("/blocks")) {
      const hs = u.searchParams.get("height")!
      const h = hs === "sealed" ? chain.sealed : Number(hs)
      return json([{ header: { height: String(h), timestamp: `2026-11-03T16:50:05.000Z#${h}` } }])
    }
    if (u.pathname.endsWith("/events")) {
      const to = { type: "Optional", value: { type: "Address", value: ADDR } }
      const payload = b64({ value: { fields: [{ name: "amount", value: { type: "UFix64", value: "0.06000000" } }, { name: "to", value: to }] } })
      return json([{ block_height: u.searchParams.get("start_height"), events: [{ type: "A.1654653399040a61.FlowToken.TokensDeposited", transaction_id: "6d23cc22", payload }] }])
    }
    if (u.pathname.endsWith("/transactions/6d23cc22")) return json({ payer: DAPPER.slice(2), authorizers: [DAPPER.slice(2)] })
    if (u.pathname.endsWith("/transaction_results/6d23cc22")) {
      return json({ events: [{ type: "A.18eb4ee6b3c026d2.PrivateReceiverForwarder.PrivateDeposit" }] })
    }
    return new Response("unexpected", { status: 418 })
  })
  return { f, calls }
}

describe("storage-fix/check — history (three states, never two)", () => {
  const sealed = 170_111_846
  const changedAt = 169_925_218 // the real block, 2026-11-03 8:50 AM PT
  const capacityAt = (h: number) => (h >= changedAt ? 6_100_000 : 100_000)

  it("finds the exact block the capacity changed, who paid, and that it came through Dapper's forwarder", async () => {
    const { f } = fakeFlow({ sealed, capacityAt })
    const h = await findLastCapacityChange(f as never, ADDR, { height: sealed, capacity: 6_100_000 })
    expect(h.status).toBe("found")
    if (h.status !== "found") return
    expect(h.change).toMatchObject({
      height: changedAt,
      capacityBefore: 100_000,
      capacityAfter: 6_100_000,
      txId: "6d23cc22",
      payer: DAPPER,
      amountFlow: 0.06,
      viaDapperForwarder: true,
      byDapper: true,
    })
    expect(historyLine(h)).toContain("Dapper itself")
  })

  it("a window reaching the spork root with no change is `none`, naming how far back it looked", async () => {
    const { f } = fakeFlow({ sealed, capacityAt: () => 6_100_000, sporkRoot: sealed - 100_000 })
    const h = await findLastCapacityChange(f as never, ADDR, { height: sealed, capacity: 6_100_000 })
    expect(h).toMatchObject({ status: "none", searchedBackTo: { height: sealed - 50_000 } })
    expect(historyLine(h)).toMatch(/^Storage capacity has not changed since /)
  })

  it("a FAILED read is `unavailable`, never `none` — the planted 500 sits where `none` would otherwise be concluded", async () => {
    const { f } = fakeFlow({ sealed, capacityAt: () => 6_100_000, failAt: sealed - 10_000 })
    const h = await findLastCapacityChange(f as never, ADDR, { height: sealed, capacity: 6_100_000 })
    expect(h.status).toBe("unavailable")
    expect(historyLine(h)).toMatch(/does NOT mean it was never topped up/)
  })

  it("a search past its deadline is `unavailable`, not a partial answer", async () => {
    const { f } = fakeFlow({ sealed, capacityAt })
    let t = 0
    const h = await findLastCapacityChange(f as never, ADDR, { height: sealed, capacity: 6_100_000 }, () => (t += 10_000))
    expect(h.status).toBe("unavailable")
  })

  it("checkStorage pins every read to ONE sealed block and returns state, plan and history together", async () => {
    const { f, calls } = fakeFlow({ sealed, capacityAt })
    const c = await checkStorage(ADDR, f as never)
    expect(c.checkedAt.height).toBe(sealed)
    expect(calls.filter((u) => u.includes("block_height=sealed"))).toEqual([])
    expect(c.state).toMatchObject({ usedBytes: 103_997, capacityBytes: 6_100_000, balanceFlow: 0.061, isDapperWallet: true })
    expect(c.plan.stuck).toBe(false)
    expect(c.history.status).toBe("found")
    expect(verdict(c)).toMatchObject({ tone: "ok" })
    expect(verdict(c).text).toContain("Dapper already fixed it.")
  })

  it("simulates the fix as the operator at the SAME sealed block, and reports the capacity it would add", async () => {
    const { f, calls } = fakeFlow({ sealed, capacityAt, simulation: "ok" })
    const c = await checkStorage(ADDR, f as never, { simulate: { from: "0x3d0b274c80263484", amount: "0.02" } })
    expect(c.simulation).toEqual({ ok: true, kind: "dapper_refill", signer: "0x3d0b274c80263484", amount: "0.02000000", capacityBefore: 6_100_000, capacityAfter: 8_100_000 })
    expect(calls.filter((u) => u.includes("/scripts")).every((u) => !u.includes("sealed"))).toBe(true)
  })

  it("a Cadence panic in the simulation is a REFUSAL carrying the panic; any other failure is a failed read", async () => {
    const panic = fakeFlow({ sealed, capacityAt, simulation: "panic" })
    expect(await simulateFix(panic.f as never, "dapper_refill", "0x3d0b274c80263484", ADDR, "0.02", sealed)).toMatchObject({
      ok: false,
      reason: "Could not borrow reference to private forwarder",
    })
    const broken = fakeFlow({ sealed, capacityAt, simulation: "error" })
    await expect(simulateFix(broken.f as never, "dapper_refill", "0x3d0b274c80263484", ADDR, "0.02", sealed)).rejects.toMatchObject({ code: "flow_http" })
  })

  it("the simulation refuses a bad signer or an out-of-bounds amount before any network call", async () => {
    const { f } = fakeFlow({ sealed, capacityAt })
    await expect(simulateFix(f as never, "dapper_refill", "nope", ADDR, "0.02", sealed)).rejects.toMatchObject({ code: "bad_signer" })
    await expect(simulateFix(f as never, "dapper_refill", "0x3d0b274c80263484", ADDR, "5", sealed)).rejects.toMatchObject({ code: "bad_amount" })
    expect(f).not.toHaveBeenCalled()
  })

  it("checkStorage refuses a malformed address before any network call", async () => {
    const { f } = fakeFlow({ sealed, capacityAt })
    await expect(checkStorage("0x123", f as never)).rejects.toMatchObject({ status: 400, code: "bad_address" })
    expect(f).not.toHaveBeenCalled()
  })

  it("decodeState refuses a wrong-shaped result rather than inventing zeros", () => {
    expect(() => decodeState({ type: "Array", value: [] })).toThrow(StorageFixError)
  })
})

describe("/api/admin/storage-fix", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("refuses without the admin token, before touching the chain", async () => {
    vi.stubEnv("RPC_ADMIN_TOKEN", "tok")
    const spy = vi.spyOn(globalThis, "fetch")
    const route = await import("@/app/api/admin/storage-fix/route")
    const r = await route.GET(new NextRequest(`http://x/api/admin/storage-fix?address=${ADDR}`))
    expect(r.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it("a bad address keeps its 400 and message (never a 500)", async () => {
    vi.stubEnv("RPC_ADMIN_TOKEN", "tok")
    const route = await import("@/app/api/admin/storage-fix/route")
    const r = await route.GET(new NextRequest("http://x/api/admin/storage-fix?address=nope", { headers: { authorization: "Bearer tok" } }))
    expect(r.status).toBe(400)
    expect(await r.json()).toMatchObject({ code: "bad_address" })
  })
})
