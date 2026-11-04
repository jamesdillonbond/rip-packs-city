// lib/trade-room/relay-guard.ts
//
// The server-side check that a relayed signable IS the trade the room agreed to.
//
// Before 2026-11-04 (CISO audit, trade-room finding H1) `relay_post` checked only
// that the signable's Cadence text was one of the two swap transactions, that
// `message` was hex and that `addr` was the co-signer. Nothing compared the
// transaction's ARGUMENTS to `trade_room_items`, and nothing compared `message`
// — the bytes the co-signer's wallet actually signs — to the voucher it claimed
// to encode. So the initiating browser could relay the real swap text with a
// different id list (any Moment the co-signer's linked accounts hold), or a
// voucher whose `message` encoded something else entirely, and the co-signer's
// only defence was reading raw numeric ids in the UI.
//
// This module closes that from the server, before the row is written:
//   1. the cadence must be the ONE text the room's items call for (Top Shot-only
//      rooms sign the original swap; anything else signs the multi-collection swap);
//   2. the voucher's cadence must equal the signable's cadence;
//   3. the voucher's authorizers must be exactly [initiator signer, co-signer] in
//      that order (the Cadence binds sourceA/idsA to the FIRST authorizer), and the
//      proposer and payer must be the initiator (the co-signer never pays);
//   4. the voucher's arguments must decode to exactly the room: each side's `source`
//      and the SET of (collection, moment_id) items recorded for that side;
//   5. `message` must equal the payload message FCL derives from the voucher for the
//      co-signer (`encodeMessageFromSignable`), so what is displayed is what is signed.
// Any mismatch refuses the relay with a 400 that names the check, never a guess.

import { encodeMessageFromSignable } from "@onflow/sdk"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import { MULTI_SWAP_CADENCE, swapCollectionByDbSlug } from "@/lib/trade-room/multi-swap-cadence"
import { describeRoomSignable } from "@/lib/trade-room/signable"
import { TradeRoomError, otherSide, type LoadedRoom, type Side } from "@/lib/trade-room/store"

const sansPrefix = (a: unknown) => (typeof a === "string" ? a.toLowerCase().replace(/^0x/, "") : "")

function sameAddress(a: unknown, b: unknown): boolean {
  const x = sansPrefix(a)
  return x.length > 0 && x === sansPrefix(b)
}

/** The one Cadence text this room may sign, from its items — the same rule planRoom applies. */
export function expectedCadence(loaded: LoadedRoom): string {
  const topShotOnly = loaded.items.every((i) => (i.collection ?? "nba_top_shot") === "nba_top_shot")
  return topShotOnly ? SWAP_CADENCE : MULTI_SWAP_CADENCE
}

/** "<short> <id>" labels for a side's recorded items — the vocabulary describeRoomSignable emits. */
export function expectedLabels(loaded: LoadedRoom, side: Side): string[] {
  return loaded.items
    .filter((i) => i.side === side)
    .map((i) => {
      const c = swapCollectionByDbSlug(i.collection ?? "nba_top_shot")
      if (!c) throw new TradeRoomError("That collection can't be traded here.", 400, "bad_collection")
      return `${c.short} ${i.moment_id}`
    })
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  if (sa.size !== a.length) return false
  return b.every((x) => sa.has(x))
}

export interface RelayGuardOptions {
  /** Override the FCL encoder (tests). */
  encode?: (signable: Record<string, unknown>, signerAddress: string) => string
}

/**
 * Throws a TradeRoomError unless `signable` is the room's agreed trade, addressed to
 * `cosigner`, with the initiator (`initiator` side) proposing and paying. Returns the
 * voucher it validated. Pure apart from the encoder; nothing is read from the chain.
 */
export function assertSignableMatchesRoom(
  loaded: LoadedRoom,
  initiator: Side,
  cosigner: string,
  signable: unknown,
  opts: RelayGuardOptions = {},
): Record<string, unknown> {
  const refuse = (msg: string, code: string): never => {
    throw new TradeRoomError(`Refusing to relay: ${msg}`, 400, code)
  }
  if (!signable || typeof signable !== "object" || Array.isArray(signable)) refuse("the signable is missing.", "bad_signable")
  const s = signable as Record<string, unknown>

  const me = loaded.sides.find((x) => x.side === initiator)
  const other = loaded.sides.find((x) => x.side === otherSide(initiator))
  if (!me?.signer || !me.source || !other?.signer || !other.source) refuse("both sides need a proven Flow Wallet.", "no_wallet")
  if (!sameAddress(other!.signer, cosigner)) refuse("the co-signer is not the other side's proven wallet.", "wrong_cosigner")

  // 1. one cadence per room shape
  const want = expectedCadence(loaded)
  if (s.cadence !== want) refuse("this transaction is not the one this trade signs.", "wrong_cadence")

  // 2–3. the voucher is what gets encoded; it must name the same text and the same signers
  const voucher = s.voucher
  if (!voucher || typeof voucher !== "object" || Array.isArray(voucher)) refuse("the signable carries no voucher.", "bad_voucher")
  const v = voucher as Record<string, unknown>
  if (v.cadence !== want) refuse("the voucher's transaction differs from the signable's.", "voucher_cadence")
  const authorizers = Array.isArray(v.authorizers) ? (v.authorizers as unknown[]) : []
  if (authorizers.length !== 2 || !sameAddress(authorizers[0], me!.signer) || !sameAddress(authorizers[1], other!.signer)) {
    refuse("the voucher's authorizers are not [initiator, co-signer].", "voucher_authorizers")
  }
  if (!sameAddress(v.payer, me!.signer)) refuse("the co-signer must never pay for a trade.", "voucher_payer")
  const proposal = v.proposalKey && typeof v.proposalKey === "object" ? (v.proposalKey as Record<string, unknown>) : null
  if (!proposal || !sameAddress(proposal.address, me!.signer)) refuse("the voucher's proposer is not the initiator.", "voucher_proposer")

  // 4. the arguments the voucher encodes must be this room's items, side for side
  const described = describeRoomSignable({ cadence: v.cadence, args: v.arguments })
  if (!described.ok) return refuse("the voucher's arguments don't decode as a trade.", "bad_arguments")
  if (!sameAddress(described.sourceA, me!.source) || !sameAddress(described.sourceB, other!.source)) {
    refuse("the voucher's wallets are not this room's two sources.", "wrong_sources")
  }
  if (!sameSet(described.idsA, expectedLabels(loaded, initiator)) || !sameSet(described.idsB, expectedLabels(loaded, otherSide(initiator)))) {
    refuse("the voucher's Moments are not the ones this room agreed.", "wrong_items")
  }

  // 5. the bytes the wallet signs must be the bytes this voucher encodes for the co-signer
  const encode = opts.encode ?? ((sig, addr) => encodeMessageFromSignable(sig as never, addr))
  let expectedMessage: string
  try {
    expectedMessage = encode(s, `0x${sansPrefix(cosigner)}`)
  } catch {
    return refuse("the voucher can't be encoded for the co-signer.", "bad_voucher")
  }
  if (typeof s.message !== "string" || s.message.toLowerCase() !== expectedMessage.toLowerCase()) {
    refuse("the signable's message is not the encoding of its voucher.", "message_mismatch")
  }
  return v
}
