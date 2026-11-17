import { describe, it, expect } from "vitest"
import {
  CAN_RECEIVE_SCRIPT,
  MULTI_SWAP_CADENCE,
  MULTI_SWAP_SIMULATION_SCRIPT,
  SWAP_COLLECTIONS,
  controllersScript,
  heldScript,
} from "@/lib/trade-room/multi-swap-cadence"
import { planMultiSwap, verifyMultiSwap, validateMultiInput, type MultiDeps, type MultiSideInput } from "@/lib/trade-room/multi-plan"
import { describeRoomSignable } from "@/lib/trade-room/signable"
import { checkSignable } from "@/lib/swap-test/relay"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import type { CdcArg, CdcValue } from "@/lib/giveaways/flow-script"

// The multi-collection trade-room swap (2026-11-02): NBA Top Shot, NFL All Day and LaLiga
// Golazos in ONE two-authorizer transaction. What must hold:
//   · the transaction and the server's simulation run the SAME legs, with the contract
//     addresses and storage paths verified against mainnet;
//   · a plan comes back only after a simulation in which EVERY moment landed, and every
//     refusal before it names the moment / account / collection — a failed chain read is a
//     502 "couldn't read", never "not held";
//   · the RECEIVING account must have the collection (a Dapper account that never held All
//     Day cannot receive one, and nothing in this transaction can create it);
//   · the relay and the co-signer accept exactly the two swap texts RPC builds.

const A = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const B = { signer: "0x68c1fb83ba8e634a", source: "0xa3d67b29e104e701" }

describe("the Cadence", () => {
  it("imports each contract from its verified mainnet address and uses the verified paths", () => {
    expect(SWAP_COLLECTIONS.map((c) => `${c.contract}@${c.address}:${c.storage}:${c.public}`)).toEqual([
      "TopShot@0x0b2a3299cc857e29:/storage/MomentCollection:/public/MomentCollection",
      "AllDay@0xe4cf4bdc1751c65d:/storage/AllDayNFTCollection:/public/AllDayNFTCollection",
      "Golazos@0x87ca73a41bb50ad5:/storage/GolazosNFTCollection:/public/GolazosNFTCollection",
      "UFC_NFT@0x329feb3ab062d289:/storage/UFC_NFTCollection:/public/UFC_NFTCollection",
    ])
    for (const c of SWAP_COLLECTIONS) {
      expect(MULTI_SWAP_CADENCE).toContain(`import ${c.contract} from ${c.address}`)
      expect(MULTI_SWAP_CADENCE).toContain(`(from: ${c.storage})`)
      expect(MULTI_SWAP_CADENCE).toContain(`.borrow<&{NonFungibleToken.Receiver}>(${c.public})`)
      // the withdrawn NFT's type is checked against THIS collection's NFT before deposit
      expect(MULTI_SWAP_CADENCE).toContain(`Type<@${c.contract}.NFT>()`)
    }
  })

  it("is one transaction with exactly two authorizers, and the simulation runs the same legs", () => {
    expect(MULTI_SWAP_CADENCE).toMatch(/prepare\(a: auth\(BorrowValue\) &Account, b: auth\(BorrowValue\) &Account\)/)
    expect(MULTI_SWAP_CADENCE.match(/\btransaction\(/g)).toHaveLength(1)
    // every borrow / move fragment of the transaction appears verbatim in the simulation
    const legs = MULTI_SWAP_CADENCE.split("\n").filter((l) => /withdraw\(withdrawID|\.deposit\(token|getCapability\(|borrowAccount\(addr|panic\("Side/.test(l)).map((l) => l.trim())
    expect(legs.length).toBeGreaterThan(20)
    for (const l of legs) expect(MULTI_SWAP_SIMULATION_SCRIPT).toContain(l.replace(/self\.p/g, "p"))
    // a cap on each side, across collections
    expect(MULTI_SWAP_CADENCE).toContain("a side gives at most 10 moments")
  })

  it("the helper scripts read the path of the collection they are for", () => {
    expect(controllersScript("/storage/AllDayNFTCollection")).toContain("getControllers(forPath: /storage/AllDayNFTCollection)")
    expect(heldScript("laliga-golazos")).toContain("import Golazos from 0x87ca73a41bb50ad5")
    expect(heldScript("laliga-golazos")).toContain("Type<@Golazos.NFT>()")
    for (const c of SWAP_COLLECTIONS) expect(CAN_RECEIVE_SCRIPT).toContain(c.public)
  })
})

// ---- a fake chain ----------------------------------------------------------------------

type Chain = {
  held: Record<string, Record<string, string[]>> // address -> collection slug -> ids held
  receive: Record<string, boolean[]>
  ctls: Record<string, Record<string, string[]>> // source -> storage path -> controller ids
  simulate: (args: CdcArg[]) => boolean[]
  fail?: RegExp
  keys?: number[]
}

function fake(c: Chain): { deps: MultiDeps; scripts: string[] } {
  const scripts: string[] = []
  const arr = (vals: unknown[], type: string): CdcValue => ({ type: "Array", value: vals.map((v) => ({ type, value: v })) })
  const run = async (script: string, args: CdcArg[]): Promise<CdcValue> => {
    scripts.push(script)
    if (c.fail && c.fail.test(script)) throw new Error("Flow script HTTP 503")
    const a0 = String(args[0]?.value)
    if (script === MULTI_SWAP_SIMULATION_SCRIPT) return arr(c.simulate(args), "Bool")
    if (script === CAN_RECEIVE_SCRIPT) return arr(c.receive[a0] ?? [false, false, false, false], "Bool")
    const ctl = script.match(/forPath: (\S+)\)/)
    if (ctl) return arr(c.ctls[String(args[1]?.value)]?.[ctl[1]] ?? [], "UInt64")
    const coll = SWAP_COLLECTIONS.find((x) => x.slug !== "nba-top-shot" && script === heldScript(x.slug as "nfl-all-day" | "laliga-golazos"))
    if (coll) {
      const asked = (args[1] as { value: Array<{ value: string }> }).value.map((x) => x.value)
      const held = new Set(c.held[a0]?.[coll.slug] ?? [])
      return arr(asked.filter((id) => held.has(id)), "UInt64")
    }
    throw new Error(`unexpected script ${script.slice(0, 40)}`)
  }
  const readTopShot = async (address: string, ids: string[]) => {
    if (c.fail && c.fail.test("TOPSHOT")) throw new Error("Flow script HTTP 503")
    const held = new Set(c.held[address]?.["nba-top-shot"] ?? [])
    return Object.fromEntries(ids.map((id) => [id, held.has(id) ? { held: true, locked: id.startsWith("9") } : { held: false, locked: null }]))
  }
  return { deps: { run, readTopShot, keys: async () => c.keys ?? [1000] }, scripts }
}

const allLand = (args: CdcArg[]) => {
  const count = (a: CdcArg) => (a.value as CdcArg[]).reduce((n, l) => n + (l.value as CdcArg[]).length, 0)
  return Array.from({ length: count(args[4]) + count(args[7]) }, () => true)
}

function happy(over: Partial<Chain> = {}): Chain {
  return {
    held: {
      [A.source]: { "nba-top-shot": ["11"], "nfl-all-day": ["6605811"], "laliga-golazos": ["912916418"], ufc: ["411978"] },
      [B.source]: { "laliga-golazos": ["913081470"], ufc: ["118675"] },
    },
    receive: { [A.source]: [true, true, true, true], [B.source]: [true, true, true, true] },
    ctls: {
      [A.source]: { "/storage/MomentCollection": ["87"], "/storage/AllDayNFTCollection": ["81"], "/storage/GolazosNFTCollection": ["57"], "/storage/UFC_NFTCollection": ["26"] },
      [B.source]: { "/storage/GolazosNFTCollection": ["91"], "/storage/UFC_NFTCollection": ["43"] },
    },
    simulate: allLand,
    ...over,
  }
}

const sideA: MultiSideInput = {
  ...A,
  picks: [
    { collection: "nba-top-shot", id: "11" },
    { collection: "nfl-all-day", id: "6605811" },
    { collection: "laliga-golazos", id: "912916418" },
    { collection: "ufc", id: "411978" },
  ],
}
const sideB: MultiSideInput = { ...B, picks: [{ collection: "laliga-golazos", id: "913081470" }, { collection: "ufc", id: "118675" }] }

describe("planMultiSwap", () => {
  it("plans all three collections from a linked Dapper account, one controller per collection given", async () => {
    const { deps } = fake(happy())
    const plan = await planMultiSwap(sideA, sideB, deps)
    expect(plan.kind).toBe("multi")
    expect(plan.a).toMatchObject({ kind: "linked", ctls: ["87", "81", "57", "26"], ids: [["11"], ["6605811"], ["912916418"], ["411978"]] })
    expect(plan.b).toMatchObject({ kind: "linked", ctls: ["0", "0", "91", "43"], ids: [[], [], ["913081470"], ["118675"]] })
  })

  it("an account with no All Day collection cannot RECEIVE one: refused before the simulation, naming it", async () => {
    const { deps, scripts } = fake(happy({ receive: { [A.source]: [true, true, true, true], [B.source]: [true, false, true, true] } }))
    await expect(planMultiSwap(sideA, sideB, deps)).rejects.toMatchObject({ code: "cannot_receive", status: 409 })
    await expect(planMultiSwap(sideA, sideB, deps)).rejects.toThrow(/0xa3d67b29e104e701 has no NFL All Day collection/)
    expect(scripts).not.toContain(MULTI_SWAP_SIMULATION_SCRIPT)
  })

  it("a moment not held is named with its collection; a Top Shot lock is refused", async () => {
    const gone = fake(happy({ held: { [A.source]: { "nba-top-shot": ["11"], "laliga-golazos": ["912916418"] }, [B.source]: { "laliga-golazos": ["913081470"] } } }))
    await expect(planMultiSwap(sideA, sideB, gone.deps)).rejects.toThrow(/does not hold NFL All Day 6605811/)
    const locked = fake(happy({ held: { [A.source]: { "nba-top-shot": ["91"] }, [B.source]: {} } }))
    await expect(planMultiSwap({ ...A, picks: [{ collection: "nba-top-shot", id: "91" }] }, { ...B, picks: [] }, locked.deps)).rejects.toMatchObject({ code: "locked" })
  })

  it("a failed chain read is 'couldn't read' (502), never 'not held'", async () => {
    const { deps } = fake(happy({ fail: /import AllDay/ }))
    const e = await planMultiSwap(sideA, sideB, deps).catch((x) => x)
    expect(e).toMatchObject({ status: 502, code: "chain_read_failed" })
    expect(String(e.message)).not.toMatch(/does not hold|not held/)
  })

  it("a linked account whose filter hides a collection from the parent is refused per collection", async () => {
    const { deps } = fake(happy({ ctls: { [A.source]: { "/storage/MomentCollection": ["87"], "/storage/GolazosNFTCollection": ["57"] }, [B.source]: { "/storage/GolazosNFTCollection": ["91"] } } }))
    await expect(planMultiSwap(sideA, sideB, deps)).rejects.toThrow(/cannot withdraw NFL All Day/)
  })

  it("a simulation that lands anything less than every moment is refused, and so is a wallet that can't sign alone", async () => {
    const partial = fake(happy({ simulate: (args) => allLand(args).map((x, i) => (i === 1 ? false : x)) }))
    await expect(planMultiSwap(sideA, sideB, partial.deps)).rejects.toMatchObject({ code: "simulation_failed" })
    const split = fake(happy({ keys: [999, 1] }))
    await expect(planMultiSwap(sideA, sideB, split.deps)).rejects.toMatchObject({ code: "cannot_sign_alone" })
  })

  it("the same id in two collections is two moments; the same collection twice is refused", () => {
    expect(() => validateMultiInput({ ...A, picks: [{ collection: "nba-top-shot", id: "1" }, { collection: "nfl-all-day", id: "1" }] }, { ...B, picks: [] })).not.toThrow()
    expect(() => validateMultiInput({ ...A, picks: [{ collection: "nfl-all-day", id: "1" }, { collection: "nfl-all-day", id: "1" }] }, { ...B, picks: [] })).toThrow(/twice/)
    expect(() => validateMultiInput({ ...A, picks: [{ collection: "disney-pinnacle" as "nfl-all-day", id: "1" }] }, { ...B, picks: [] })).toThrow(/can't be traded here/)
    const eleven = Array.from({ length: 11 }, (_, i) => ({ collection: (i % 2 ? "nfl-all-day" : "laliga-golazos") as "nfl-all-day", id: String(i + 1) }))
    expect(() => validateMultiInput({ ...A, picks: eleven }, { ...B, picks: [] })).toThrow(/at most 10/)
  })

  it("verify reads where each moment is now, per collection; a failed read throws instead of 'not landed'", async () => {
    const after = fake(happy({ held: { [B.source]: { "nba-top-shot": ["11"], "nfl-all-day": ["6605811"], "laliga-golazos": ["912916418"], ufc: ["411978"] }, [A.source]: { ufc: ["118675"] } } }))
    const landed = await verifyMultiSwap(sideA, sideB, after.deps)
    expect(landed.map((l) => `${l.collection}:${l.id}:${l.held}`)).toEqual([
      "nba-top-shot:11:true",
      "nfl-all-day:6605811:true",
      "laliga-golazos:912916418:true",
      "ufc:411978:true",
      "laliga-golazos:913081470:false",
      "ufc:118675:true",
    ])
    const down = fake(happy({ fail: /import UFC_NFT/ }))
    await expect(verifyMultiSwap(sideA, sideB, down.deps)).rejects.toMatchObject({ status: 502 })
  })
})

describe("what the co-signer reads, and what may be relayed", () => {
  const multiArgs = (idsA: string[][], idsB: string[][]) => [
    { type: "Address", value: A.source },
    { type: "Array", value: ["87", "81", "57", "26"].map((v) => ({ type: "UInt64", value: v })) },
    { type: "Array", value: idsA.map((l) => ({ type: "Array", value: l.map((v) => ({ type: "UInt64", value: v })) })) },
    { type: "Address", value: B.source },
    { type: "Array", value: ["0", "0", "91", "43"].map((v) => ({ type: "UInt64", value: v })) },
    { type: "Array", value: idsB.map((l) => ({ type: "Array", value: l.map((v) => ({ type: "UInt64", value: v })) })) },
  ]

  it("decodes the multi swap from its own arguments, labelled by collection", () => {
    const d = describeRoomSignable({ cadence: MULTI_SWAP_CADENCE, args: multiArgs([["11"], ["6605811"], [], []], [[], [], ["913081470"], ["118675"]]) })
    expect(d).toEqual({ ok: true, sourceA: A.source, idsA: ["Top Shot 11", "All Day 6605811"], sourceB: B.source, idsB: ["Golazos 913081470", "UFC 118675"] })
  })

  it("anything else — another text, or arguments that don't decode — is not signable", () => {
    expect(describeRoomSignable({ cadence: "transaction { execute {} }", args: [] })).toMatchObject({ ok: false })
    // ⛔ a foreign transaction carrying perfectly shaped swap arguments is still not ours
    const shaped = multiArgs([["11"], [], [], []], [[], [], [], []])
    expect(describeRoomSignable({ cadence: MULTI_SWAP_CADENCE.replace("0xe4cf4bdc1751c65d", "0x0000000000000001"), args: shaped })).toMatchObject({ ok: false })
    expect(describeRoomSignable({ cadence: "transaction(a: Address) { execute {} }", args: shaped })).toMatchObject({ ok: false })
    expect(describeRoomSignable({ cadence: MULTI_SWAP_CADENCE, args: multiArgs([["11"], ["x"], [], []], [[], [], [], []]) })).toMatchObject({ ok: false })
    // a list per collection — two lists is not this transaction's shape
    expect(describeRoomSignable({ cadence: MULTI_SWAP_CADENCE, args: multiArgs([["11"], []], [[], []]) })).toMatchObject({ ok: false })
  })

  it("the admin swap-test relay still takes ONLY the Top Shot swap; a trade room takes exactly the two", () => {
    const signable = (cadence: string) => ({ cadence, message: "ab", addr: B.signer })
    expect(() => checkSignable(B.signer, signable(MULTI_SWAP_CADENCE))).toThrow(/Only the swap-test transaction/)
    expect(() => checkSignable(B.signer, signable(SWAP_CADENCE))).not.toThrow()
    const room = [SWAP_CADENCE, MULTI_SWAP_CADENCE]
    expect(() => checkSignable(B.signer, signable(MULTI_SWAP_CADENCE), room)).not.toThrow()
    expect(() => checkSignable(B.signer, signable(MULTI_SWAP_CADENCE.replace("0xe4cf4bdc1751c65d", "0x0000000000000001")), room)).toThrow()
  })
})
