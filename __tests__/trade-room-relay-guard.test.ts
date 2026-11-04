import { describe, it, expect } from "vitest"
import { assertSignableMatchesRoom, expectedCadence, expectedLabels } from "@/lib/trade-room/relay-guard"
import { MULTI_SWAP_CADENCE } from "@/lib/trade-room/multi-swap-cadence"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import type { LoadedRoom, ItemRow, SideRow } from "@/lib/trade-room/store"

// CISO audit 2026-11-04, trade-room finding H1: before this guard, relay_post accepted any
// signable whose Cadence text was one of the two swap transactions — the arguments (which
// Moments move, from which accounts) and the signed `message` were never compared to the
// room. Every test below PLANTS one defect in an otherwise valid signable and asserts the
// guard names it; the last one asserts the valid signable passes, so the guard is not vacuous.

const A = { signer: "0x3d0b274c80263484", source: "0xbd94cade097e50ac" }
const B = { signer: "0x68c1fb83ba8e634a", source: "0xa3d67b29e104e701" }

const u64 = (v: string) => ({ type: "UInt64", value: v })
const addr = (v: string) => ({ type: "Address", value: v })
const arr = (v: unknown[]) => ({ type: "Array", value: v })

function side(s: "a" | "b", w: { signer: string; source: string }): SideRow {
  return { room_id: "r", side: s, user_id: `u-${s}`, signer: w.signer, source: w.source, proven_at: "t", accepted_version: 3, notice_read_at: null, updated_at: "t" }
}
function item(s: "a" | "b", collection: ItemRow["collection"], id: string): ItemRow {
  return { room_id: "r", side: s, collection, moment_id: id, edition_key: null, serial_number: null, player_name: null, set_name: null, tier: null, series_number: null, image_url: null, fmv_usd: null, added_at: "t" }
}
function room(items: ItemRow[]): LoadedRoom {
  return {
    room: { id: "r", code: "abcdefghij", created_by: "u-a", collection: "mixed", status: "accepted", version: 3, tx_id: null, landed: null, sealed_at: null, cancelled_by: null, cancel_reason: null, expires_at: "t", created_at: "t", updated_at: "t" },
    sides: [side("a", A), side("b", B)],
    items,
  }
}

/** A multi-collection room: A gives Top Shot 11 + All Day 22; B gives Golazos 33. */
const MULTI = room([item("a", "nba_top_shot", "11"), item("a", "nfl_all_day", "22"), item("b", "laliga_golazos", "33")])
/** The argument list the multi swap encodes: sourceA, ctlsA, idsA[[per collection]], sourceB, ctlsB, idsB. */
function multiArgs(idsA = [["11"], ["22"], [], []], idsB = [[], [], ["33"], []]) {
  const nest = (l: string[][]) => arr(l.map((ids) => arr(ids.map(u64))))
  return [addr(A.source), arr(["0", "0", "0", "0"].map(u64)), nest(idsA), addr(B.source), arr(["0", "0", "0", "0"].map(u64)), nest(idsB)]
}

/** The encoder stands in for FCL: deterministic over the voucher, so a tampered message is detectable. */
const encode = (s: Record<string, unknown>, who: string) => `enc:${who}:${JSON.stringify(s.voucher)}`

function signable(over: Partial<Record<string, unknown>> = {}, voucherOver: Partial<Record<string, unknown>> = {}) {
  const voucher = {
    cadence: MULTI_SWAP_CADENCE,
    authorizers: [A.signer, B.signer],
    payer: A.signer,
    proposalKey: { address: A.signer, keyId: 0, sequenceNum: 1 },
    refBlock: "ab",
    computeLimit: 9999,
    arguments: multiArgs(),
    payloadSigs: [],
    ...voucherOver,
  }
  const base: Record<string, unknown> = { cadence: MULTI_SWAP_CADENCE, addr: B.signer, args: voucher.arguments, voucher, roles: { authorizer: true } }
  base.message = encode(base, B.signer)
  return { ...base, ...over }
}

const refuses = (loaded: LoadedRoom, s: unknown, code: string) => {
  expect(() => assertSignableMatchesRoom(loaded, "a", B.signer, s, { encode })).toThrowError(expect.objectContaining({ code }))
}

describe("expectedCadence / expectedLabels", () => {
  it("a Top Shot-only room signs the original swap; anything else the multi swap", () => {
    expect(expectedCadence(room([item("a", "nba_top_shot", "1"), item("b", "nba_top_shot", "2")]))).toBe(SWAP_CADENCE)
    expect(expectedCadence(MULTI)).toBe(MULTI_SWAP_CADENCE)
    expect(expectedLabels(MULTI, "a")).toEqual(["Top Shot 11", "All Day 22"])
    expect(expectedLabels(MULTI, "b")).toEqual(["Golazos 33"])
  })
})

describe("assertSignableMatchesRoom refuses, naming the planted defect", () => {
  it("a signable with no voucher", () => refuses(MULTI, signable({ voucher: undefined }), "bad_voucher"))
  it("the wrong cadence for the room's shape (Top Shot swap in a mixed room)", () => {
    refuses(MULTI, signable({ cadence: SWAP_CADENCE }), "wrong_cadence")
  })
  it("a voucher whose cadence differs from the signable's", () => refuses(MULTI, signable({}, { cadence: SWAP_CADENCE }), "voucher_cadence"))
  it("authorizers swapped (the Cadence binds sourceA/idsA to the FIRST authorizer)", () => {
    refuses(MULTI, signable({}, { authorizers: [B.signer, A.signer] }), "voucher_authorizers")
  })
  it("a third authorizer", () => refuses(MULTI, signable({}, { authorizers: [A.signer, B.signer, "0x1111111111111111"] }), "voucher_authorizers"))
  it("the co-signer named as payer", () => refuses(MULTI, signable({}, { payer: B.signer }), "voucher_payer"))
  it("the co-signer named as proposer", () => refuses(MULTI, signable({}, { proposalKey: { address: B.signer } }), "voucher_proposer"))
  it("an extra Moment of the co-signer's slipped into idsB (the H1 attack)", () => {
    refuses(MULTI, signable({}, { arguments: multiArgs([["11"], ["22"], [], []], [[], [], ["33", "34"], []]) }), "wrong_items")
  })
  it("a Moment moved to another collection slot (same number, different contract)", () => {
    refuses(MULTI, signable({}, { arguments: multiArgs([["11", "22"], [], [], []], [[], [], ["33"], []]) }), "wrong_items")
  })
  it("the initiator giving less than agreed", () => {
    refuses(MULTI, signable({}, { arguments: multiArgs([["11"], [], [], []], [[], [], ["33"], []]) }), "wrong_items")
  })
  it("sourceB pointed at a different account", () => {
    const args = multiArgs()
    args[3] = addr("0x1111111111111111")
    refuses(MULTI, signable({}, { arguments: args }), "wrong_sources")
  })
  it("arguments that don't decode", () => refuses(MULTI, signable({}, { arguments: [addr(A.source)] }), "bad_arguments"))
  it("a message that is not the encoding of the voucher shown", () => {
    refuses(MULTI, signable({ message: "deadbeef" }), "message_mismatch")
  })
  it("a signable addressed to someone other than the co-signer", () => {
    expect(() => assertSignableMatchesRoom(MULTI, "a", "0x1111111111111111", signable(), { encode })).toThrowError(expect.objectContaining({ code: "wrong_cosigner" }))
  })
  it("a room with an unproven side", () => {
    const r = room(MULTI.items)
    r.sides[1] = { ...r.sides[1], source: null }
    refuses(r, signable(), "no_wallet")
  })
})

describe("assertSignableMatchesRoom accepts the agreed trade", () => {
  it("the valid multi-collection signable, whatever order the ids are listed in", () => {
    const v = assertSignableMatchesRoom(MULTI, "a", B.signer, signable(), { encode })
    expect(v.cadence).toBe(MULTI_SWAP_CADENCE)
    const shuffled = room([item("a", "nfl_all_day", "22"), item("b", "laliga_golazos", "33"), item("a", "nba_top_shot", "11")])
    expect(() => assertSignableMatchesRoom(shuffled, "a", B.signer, signable(), { encode })).not.toThrow()
  })
  it("the original Top Shot swap for a Top Shot-only room (sourceA, ctlA, idsA, sourceB, ctlB, idsB)", () => {
    const ts = room([item("a", "nba_top_shot", "11"), item("b", "nba_top_shot", "99")])
    const args = [addr(A.source), u64("0"), arr([u64("11")]), addr(B.source), u64("0"), arr([u64("99")])]
    const s = signable({ cadence: SWAP_CADENCE, args }, { cadence: SWAP_CADENCE, arguments: args })
    s.message = encode(s, B.signer)
    expect(() => assertSignableMatchesRoom(ts, "a", B.signer, s, { encode })).not.toThrow()
    // and the planted defect still bites on that shape: B's id swapped for another
    const bad = signable({ cadence: SWAP_CADENCE, args }, { cadence: SWAP_CADENCE, arguments: [addr(A.source), u64("0"), arr([u64("11")]), addr(B.source), u64("0"), arr([u64("98")])] })
    bad.message = encode(bad, B.signer)
    expect(() => assertSignableMatchesRoom(ts, "a", B.signer, bad, { encode })).toThrowError(expect.objectContaining({ code: "wrong_items" }))
  })
  it("uses FCL's own encoder by default (a real voucher round-trips)", async () => {
    const { encodeMessageFromSignable } = await import("@onflow/sdk")
    const s = signable()
    s.message = encodeMessageFromSignable(s as never, B.signer)
    expect(() => assertSignableMatchesRoom(MULTI, "a", B.signer, s)).not.toThrow()
    s.message = (s.message as string).replace(/^.{2}/, (c: string) => (c === "00" ? "11" : "00"))
    expect(() => assertSignableMatchesRoom(MULTI, "a", B.signer, s)).toThrowError(expect.objectContaining({ code: "message_mismatch" }))
  })
})
