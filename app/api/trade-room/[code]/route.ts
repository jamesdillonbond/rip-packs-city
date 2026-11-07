// app/api/trade-room/[code]/route.ts
//
// One trade room (Trevor, 2026-10-31: user-to-user trades — Top Shot, and since 2026-11-02
// All Day and Golazos in the same room — two signatures
// on one transaction, no custody). Signed in only; every mutation is scoped to the
// caller's OWN side. RPC never holds a key, a moment or a fee.
//
//   GET                        -> { room: RoomView }   (a room the caller may join is visible to them)
//   GET ?relay=<id>            -> { relay }            the initiator polling for the co-signature
//   GET ?picker=1&q=<player>&collection=<slug>
//                              -> { picker }           the caller's source account's indexed moments of ONE
//                                                      collection (nba-top-shot default, nfl-all-day, laliga-golazos)
//   GET ?nonce=1               -> { nonce, issuedAt }  for Flow Wallet's account proof
//   GET ?receive=1             -> { receive: {a, b} }  per proven side: which collections its account can receive
//   POST { action, ... }:
//     join                                 -> the caller becomes side B
//     wallet   { proof, source? }          -> prove a Flow Wallet; list its accounts; with `source`, save both
//     items    { picks: [{collection, id}] } -> this side gives these moments (chain-checked: held + unlocked,
//                                          and the other side's account can receive each collection);
//              { ids }                     -> the same, all Top Shot (the original shape)
//     accept   { version, notice_read }    -> accept the proposal as seen
//     unaccept                             -> withdraw an acceptance
//     cancel   { reason? }                 -> either side, any time before the seal
//     simulate                             -> the whole swap simulated on mainnet (a READ; always allowed)
//     relay_post { cosigner, signable }    -> ⛔ gated by RPC_TRADE_ROOM_EXECUTE: asks the other wallet to sign.
//                                          The signable is checked AGAINST THE ROOM on the server
//                                          (lib/trade-room/relay-guard.ts, 2026-11-04): cadence, authorizers,
//                                          payer, every Moment per side, and message == encode(voucher).
//     relay_sign { id, signature, key_id } -> the co-signer's signature (room must still be `signing`
//                                          and execution open — a relay never outlives its room)
//     signing_ended                        -> the initiator reports a signing attempt that did not seal
//     sealed   { tx_id }                   -> record the seal ONLY after the chain confirms every Moment
//                                          sits with the other side (a failed read is 503, never a seal)
//     verify                               -> read the chain again (after a seal)
//
// Three outcomes, never two: a check that fails names what failed; a chain that
// could not be asked answers 503 + retryable, never "not held" or "not yours".

import { NextRequest, NextResponse, after } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { FlowScriptError, runFlowScript } from "@/lib/giveaways/flow-script"
import { discoverAccounts } from "@/lib/giveaways/linked-accounts"
import { issueClaimNonce, verifyClaimProof, type ClaimProofInput } from "@/lib/giveaways/claim-proof"
import { getRelay, postSignable, postSignature } from "@/lib/swap-test/relay"
import {
  accept,
  cancelRoom,
  joinRoom,
  loadRoom,
  markSealed,
  markSigning,
  markSigningEnded,
  otherSide,
  setItems,
  setWallet,
  sideOf,
  asTradeRoomError,
  TradeRoomError,
  unaccept,
  type LoadedRoom,
  type SideRow,
} from "@/lib/trade-room/store"
import { chainUnavailable, checkReceivable, checkRoomPicks, EXECUTE_CLOSED_MESSAGE, executionOpen, planRoom, verifyRoom } from "@/lib/trade-room/execute"
import { assertSignableMatchesRoom } from "@/lib/trade-room/relay-guard"
import { pickItems, readChainPicker, readPickedRows, readPicker, withLiveLocks, TOP_SHOT_COLLECTION_ID, type PickerResult } from "@/lib/trade-room/holdings"
import { holdingsReader, idsReader, readCanReceive, type Pick } from "@/lib/trade-room/multi-plan"
import { MULTI_SWAP_CADENCE, swapCollection, swapCollectionByDbSlug, SWAP_COLLECTIONS, type SwapSlug } from "@/lib/trade-room/multi-swap-cadence"
import { SWAP_CADENCE } from "@/lib/swap-test/swap-cadence"
import type { NewItem } from "@/lib/trade-room/store"
import { MAX_ITEMS_PER_SIDE } from "@/lib/trade-room/valuation"
import { buildRoomView, cosignerOf, usernamesFor, type PendingRelay } from "@/lib/trade-room/view"
import { notifyOtherSide, type TradeNotice } from "@/lib/trade-room/notify"
import { proposalForRoom } from "@/lib/trade-block/store"
import { readTopShotListed } from "@/lib/trade-room/topshot-listed"

export const dynamic = "force-dynamic"
// a simulation makes several Flow script calls (20 s bound each)
export const maxDuration = 60

const NO_STORE = { "Cache-Control": "no-store" }

// The other collector is emailed AFTER the response (fire-and-forget): a notice can
// never fail or slow the action it follows, and a failed send is logged, not retried.
function notifyLater(loaded: LoadedRoom, actorUserId: string, notice: TradeNotice) {
  const run = () => notifyOtherSide(supabaseAdmin, loaded, actorUserId, notice)
  try {
    after(run)
  } catch {
    // outside a request scope (tests, a non-Next caller) `after` throws; the notice
    // must never fail the action that already landed, so run it detached instead
    void run()
  }
}
const RELAY_TABLE = "trade_room_relay" as const
// the only two transactions a trade room may ask a wallet to co-sign
const TRADE_ROOM_CADENCES = [SWAP_CADENCE, MULTI_SWAP_CADENCE] as const
const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/

type Ctx = { params: Promise<{ code: string }> }

// Each proof check costs one Cadence script on a public access node; per-user cap.
const PROOF_WINDOW_MS = 60_000
const PROOF_MAX = 10
const proofHits = new Map<string, number[]>()
function proofRateLimited(userId: string, now = Date.now()): boolean {
  const hits = (proofHits.get(userId) ?? []).filter((t) => now - t < PROOF_WINDOW_MS)
  const limited = hits.length >= PROOF_MAX
  if (!limited) hits.push(now)
  proofHits.set(userId, hits)
  return limited
}
/** Test hook. */
export function __resetProofRateLimit() {
  proofHits.clear()
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

function failure(e: unknown, where: string): NextResponse {
  if (e instanceof FlowScriptError) return json({ error: "We couldn't reach the Flow blockchain. Try again in a minute.", code: "upstream_unavailable", retryable: true }, 503)
  // our own copy (TradeRoomError, and the sibling helpers' SwapTestError / GiveawayError): published as written
  const own = asTradeRoomError(e)
  if (own) return json({ error: own.copy, code: own.code, retryable: own.status >= 500 }, own.status)
  return apiErrorResponse(e, `api/trade-room/[code] ${where}`, "Something went wrong with this trade. Try again in a moment.")
}

async function currentUser() {
  try {
    return await requireUser()
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
}

/** A relay row of THIS room addressed to the viewer's wallet and still unsigned. */
async function pendingRelayFor(loaded: LoadedRoom, me: SideRow | null): Promise<PendingRelay | null> {
  if (!me?.signer || loaded.room.status !== "signing") return null
  const { data, error } = await supabaseAdmin
    .from(RELAY_TABLE)
    .select("id, cosigner, signable, created_at")
    .eq("room_id", loaded.room.id)
    .eq("cosigner", me.signer)
    .is("signature", null)
    .order("created_at", { ascending: false })
    .limit(1)
  if (error) throw new Error(`${RELAY_TABLE} read failed: ${error.message}`)
  const row = (data ?? [])[0] as PendingRelay | undefined
  if (!row) return null
  // an expired relay is not pending
  if (Date.now() - Date.parse(row.created_at) > 15 * 60 * 1000) return null
  return row
}

async function view(loaded: LoadedRoom, userId: string) {
  const me = sideOf(loaded, userId)
  const [names, relay, fromBlock] = await Promise.all([
    usernamesFor(supabaseAdmin, loaded.sides.map((s) => s.user_id)),
    pendingRelayFor(loaded, me),
    // the Trade Block proposal this room came from, as a guide; a failed read only drops
    // the guide (it is never a pick), so it must not fail the room
    proposalForRoom(supabaseAdmin, loaded.room.code).catch((e) => {
      console.error(`[trade-room] from-block read failed: ${e instanceof Error ? e.message : String(e)}`)
      return null
    }),
  ])
  return buildRoomView(loaded, userId, names, { relay, fromBlock })
}

/** `picks: [{collection, id}]`, or the original all-Top-Shot `ids: [...]`. Refuses an unknown collection. */
function readPicks(body: Record<string, unknown>): Pick[] {
  if (Array.isArray(body.picks)) {
    return body.picks.map((p) => {
      const r = (p ?? {}) as Record<string, unknown>
      const c = swapCollection(String(r.collection ?? ""))
      if (!c) throw new TradeRoomError("That collection can't be traded here.", 400, "bad_collection")
      return { collection: c.slug, id: String(r.id ?? "").trim() }
    })
  }
  const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x).trim()).filter(Boolean) : []
  return ids.map((id) => ({ collection: "nba-top-shot" as const, id }))
}

function mySide(loaded: LoadedRoom, userId: string): SideRow {
  const me = sideOf(loaded, userId)
  if (!me) throw new TradeRoomError("You're not in this trade.", 403, "not_in_room")
  return me
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const u = await currentUser()
  if (u instanceof Response) return u
  const { code } = await ctx.params
  const sp = req.nextUrl.searchParams
  try {
    if (sp.has("nonce")) return json(issueClaimNonce(u.id))
    const loaded = await loadRoom(supabaseAdmin, code)
    const me = sideOf(loaded, u.id)
    const relayId = sp.get("relay")
    if (relayId) {
      mySide(loaded, u.id)
      const relay = await getRelay(supabaseAdmin, relayId, Date.now(), RELAY_TABLE)
      if (relay.room_id !== loaded.room.id) throw new TradeRoomError("No such relay.", 404, "no_relay")
      return json({ relay })
    }
    if (sp.has("receive")) {
      // which collections each side's account can RECEIVE (2026-11-03, Trevor: "We should have a
      // way to check if the wallet is able to receive"), read from the chain now. A side with no
      // proven account is null; a failed read is the 503 below, never "can't receive".
      mySide(loaded, u.id)
      const out: Record<"a" | "b", Record<string, boolean> | null> = { a: null, b: null }
      for (const s of loaded.sides) {
        if (!s.source) continue
        let r: boolean[]
        try {
          r = await readCanReceive(s.source, runFlowScript)
        } catch (e) {
          throw chainUnavailable(e)
        }
        out[s.side] = Object.fromEntries(SWAP_COLLECTIONS.map((c, i) => [c.slug, r[i] === true]))
      }
      return json({ receive: out })
    }
    if (sp.has("picker")) {
      const side = mySide(loaded, u.id)
      if (!side.source) throw new TradeRoomError("Connect and prove your Flow Wallet first.", 409, "no_wallet")
      const slug = sp.get("collection") ?? "nba-top-shot"
      // an unknown collection is refused, never answered with Top Shot's moments
      if (!swapCollection(slug)) throw new TradeRoomError("That collection can't be traded here.", 400, "bad_collection")
      // #222: lock state for the rows shown is read from the CHAIN now (cached hint on failure),
      // and a live Top Shot read heals wmc's flag for those rows in the background.
      if (slug !== "nba-top-shot") {
        // All Day / Golazos / UFC: start from what the CHAIN says the account holds (RPC's index
        // can list Moments long gone); a failed chain read falls back to RPC's index, labelled cached
        const other = slug as Exclude<SwapSlug, "nba-top-shot">
        try {
          return json({ picker: await readChainPicker(supabaseAdmin, side.source, sp.get("q"), other, idsReader(other)) })
        } catch (e) {
          console.error(`[trade-room] chain picker failed (${other}): ${e instanceof Error ? e.message : String(e)}`)
          return json({ picker: { ...(await readPicker(supabaseAdmin, side.source, sp.get("q"), other)), lock_state: "cached" } })
        }
      }
      const picker = await withLiveLocks(await readPicker(supabaseAdmin, side.source, sp.get("q"), "nba-top-shot"), side.source, holdingsReader("nba-top-shot"), undefined, readTopShotListed)
      if (picker.lock_state === "live") after(() => healLockCache(side.source as string, picker))
      return json({ picker })
    }
    // a stranger may look at an open room (that is how they join); a finished or full
    // room they are not part of is not theirs to read
    if (!me && !(loaded.room.status === "open" && loaded.sides.length < 2)) throw new TradeRoomError("No such trade.", 404, "not_found")
    return json({ room: await view(loaded, u.id) })
  } catch (e) {
    return failure(e, "GET")
  }
}

/** Write a LIVE picker lock read back to wmc through the lock-check lane's own writer (stamps
 *  lock_checked_at). Best-effort: a failure leaves the cache as it was and is logged, never thrown. */
async function healLockCache(source: string, picker: PickerResult): Promise<void> {
  const results = picker.rows
    .filter((r) => r.held_live === true && typeof r.locked_hint === "boolean")
    .map((r) => ({ wallet_address: source, moment_id: r.moment_id, collection_id: TOP_SHOT_COLLECTION_ID, is_locked: r.locked_hint }))
  if (results.length === 0) return
  // Bounded: a cache heal must never hold the function open (api-routes-that-degrade-honestly-also-bound-their-reads).
  const { error } = await (supabaseAdmin as any)
    .rpc("apply_lock_check_batch", { p_results: results })
    .abortSignal(AbortSignal.timeout(8_000))
  if (error) console.error(`[trade-room] lock cache heal failed for ${results.length} row(s): ${error.message}`)
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const u = await currentUser()
  if (u instanceof Response) return u
  const { code } = await ctx.params
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: "Body must be JSON.", code: "bad_request" }, 400)
  }
  try {
    let loaded = await loadRoom(supabaseAdmin, code)
    const action = String(body?.action ?? "")
    if (action === "join") {
      const before = loaded.sides.length
      loaded = await joinRoom(supabaseAdmin, loaded, u.id)
      if (loaded.sides.length > before) notifyLater(loaded, u.id, "joined")
      return json({ room: await view(loaded, u.id) })
    }
    const me = mySide(loaded, u.id)
    switch (action) {
      case "wallet": {
        if (proofRateLimited(u.id)) return json({ error: "Too many tries. Wait a minute and try again.", code: "rate_limited" }, 429)
        const out = await verifyClaimProof(u.id, req.nextUrl.origin, body.proof as ClaimProofInput | null)
        if (!out.ok) return json({ error: out.error, code: out.code }, 400)
        const accounts = (await discoverAccounts(out.address)).map((a) => ({
          address: a.address,
          role: a.role,
          name: a.name,
          dapper: a.dapper,
          topshot_count: a.topshot_count,
        }))
        const source = typeof body.source === "string" ? body.source.trim().toLowerCase() : ""
        if (!source) return json({ signer: out.address, accounts })
        if (!FLOW_ADDRESS.test(source) || !accounts.some((a) => a.address === source)) {
          throw new TradeRoomError("Pick an account this wallet owns or links.", 400, "bad_source")
        }
        // which collections the account can give or receive is checked per collection before
        // anyone signs (lib/trade-room/multi-plan.ts) — Top Shot, All Day and Golazos alike
        // the account this side will RECEIVE into must hold every collection the other side gives
        const theirPicks: Pick[] = loaded.items
          .filter((i) => i.side !== me.side)
          .map((i) => ({ collection: (swapCollectionByDbSlug(i.collection ?? "nba_top_shot")?.slug ?? "nba-top-shot") as Pick["collection"], id: i.moment_id }))
        if (theirPicks.length) await checkReceivable(source, theirPicks)
        loaded = await setWallet(supabaseAdmin, loaded, me, out.address, source)
        return json({ room: await view(loaded, u.id), signer: out.address, accounts })
      }
      case "items": {
        if (!me.source) throw new TradeRoomError("Connect and prove your Flow Wallet before picking Moments.", 409, "no_wallet")
        const picks = readPicks(body)
        // The cap BEFORE any read (2026-11-07 review): setItems enforces it too, but only after
        // the wmc reads and the per-collection chain scripts had run over every submitted id.
        if (picks.length > MAX_ITEMS_PER_SIDE) throw new TradeRoomError(`At most ${MAX_ITEMS_PER_SIDE} Moments per side.`, 400, "too_many")
        const items: NewItem[] = []
        for (const c of SWAP_COLLECTIONS) {
          const ids = picks.filter((p) => p.collection === c.slug).map((p) => p.id)
          if (!ids.length) continue
          const rows = await readPickedRows(supabaseAdmin, me.source, c.slug, ids)
          const { items: got, unknown } = pickItems(rows, ids)
          if (unknown.length) throw new TradeRoomError(`RPC hasn't indexed ${c.label} ${unknown.join(", ")} for that account yet.`, 409, "not_indexed")
          items.push(...got)
        }
        await checkRoomPicks(me.source, picks)
        // the other side must be able to receive what is picked (re-checked by the planner)
        const other = loaded.sides.find((s) => s.side !== me.side)
        if (other?.source) await checkReceivable(other.source, picks)
        loaded = await setItems(supabaseAdmin, loaded, me, items)
        return json({ room: await view(loaded, u.id) })
      }
      case "accept": {
        const alreadyMine = me.accepted_version === loaded.room.version
        loaded = await accept(supabaseAdmin, loaded, me, Number(body.version), body.notice_read === true)
        // one notice per acceptance: "your turn" while the other side is behind, "ready" once both match
        if (!alreadyMine) notifyLater(loaded, u.id, loaded.room.status === "accepted" ? "ready" : "accepted")
        return json({ room: await view(loaded, u.id) })
      }
      case "unaccept":
        loaded = await unaccept(supabaseAdmin, loaded, me)
        return json({ room: await view(loaded, u.id) })
      case "cancel": {
        const wasLive = loaded.room.status !== "cancelled" && loaded.room.status !== "sealed"
        loaded = await cancelRoom(supabaseAdmin, loaded, u.id, typeof body.reason === "string" ? body.reason : null)
        if (wasLive) notifyLater(loaded, u.id, "cancelled")
        return json({ room: await view(loaded, u.id) })
      }
      case "simulate":
        return json({ plan: await planRoom(loaded, me.side) })
      case "relay_post": {
        if (!executionOpen()) throw new TradeRoomError(EXECUTE_CLOSED_MESSAGE, 503, "execute_closed")
        const cosigner = typeof body.cosigner === "string" ? body.cosigner.trim().toLowerCase() : ""
        const other = cosignerOf(loaded, me.side)
        if (!other?.signer || other.signer !== cosigner) throw new TradeRoomError("The co-signer must be the other side's proven wallet.", 400, "wrong_cosigner")
        // the room must be accepted by both sides at THIS version before anything is signed
        if (loaded.room.status !== "accepted" && loaded.room.status !== "signing") throw new TradeRoomError("Both sides must accept the trade before signing.", 409, "not_accepted")
        // the signable must BE this room's trade: cadence, authorizers, payer, every Moment per side,
        // and the signed bytes must be the encoding of the voucher shown — checked before the row exists
        assertSignableMatchesRoom(loaded, me.side, cosigner, body.signable)
        await markSigning(supabaseAdmin, loaded)
        const id = await postSignable(supabaseAdmin, cosigner, body.signable, Date.now(), { table: RELAY_TABLE, extra: { room_id: loaded.room.id }, allowed: TRADE_ROOM_CADENCES })
        return json({ id })
      }
      case "relay_sign": {
        // a relay never outlives its room: the kill switch and the status are re-checked here, and the stored
        // signable is re-checked against the room AS IT IS NOW (an edit bumps the version and clears the
        // acceptances, so the room leaves `signing`; a relay from before that is refused either way),
        // not only when the relay was posted (a relay posted before a cancel or an edit must not be signable)
        if (!executionOpen()) throw new TradeRoomError(EXECUTE_CLOSED_MESSAGE, 503, "execute_closed")
        if (loaded.room.status !== "signing") throw new TradeRoomError("This trade is not being signed right now.", 409, "not_signing")
        const id = String(body.id ?? "")
        const relay = await getRelay(supabaseAdmin, id, Date.now(), RELAY_TABLE)
        if (relay.room_id !== loaded.room.id || relay.cosigner !== me.signer) throw new TradeRoomError("This signing request isn't addressed to your wallet.", 403, "wrong_cosigner")
        // the stored signable is re-checked against the room as it is NOW, so an edit between post and sign is refused
        assertSignableMatchesRoom(loaded, otherSide(me.side), me.signer as string, relay.signable)
        await postSignature(supabaseAdmin, id, body.signature, body.key_id, Date.now(), RELAY_TABLE)
        return json({ ok: true })
      }
      case "signing_ended":
        await markSigningEnded(supabaseAdmin, loaded)
        return json({ room: await view(await loadRoom(supabaseAdmin, code), u.id) })
      case "sealed": {
        const txId = typeof body.tx_id === "string" ? body.tx_id.trim().toLowerCase().replace(/^0x/, "") : ""
        const wasSealed = loaded.room.status === "sealed"
        // a seal already recorded keeps its tx_id: a second "sealed" never overwrites the first
        if (wasSealed) return json({ room: await view(loaded, u.id), verified: loaded.room.landed != null })
        // "cancelled" is allowed (2026-11-07 review): a cancel that raced the seal must not
        // leave an executed trade recorded as cancelled. The chain read below decides.
        if (loaded.room.status !== "signing" && loaded.room.status !== "accepted" && loaded.room.status !== "cancelled") throw new TradeRoomError("This trade is not in a state that can seal.", 409, "not_signing")
        // the seal is a CHAIN fact, not a claim: read where every Moment sits before recording it.
        // A read that fails is 503 + retryable (call `sealed` again), never a seal and never "not landed".
        let landed: Array<{ held: boolean }>
        try {
          landed = (await verifyRoom(loaded)) as Array<{ held: boolean }>
        } catch (e) {
          throw chainUnavailable(e)
        }
        if (landed.length === 0 || !landed.every((m) => m.held === true)) {
          throw new TradeRoomError("The chain doesn't show this trade completed yet. If the transaction just sealed, try again in a moment.", 409, "not_landed")
        }
        loaded = await markSealed(supabaseAdmin, loaded, txId, landed)
        notifyLater(loaded, u.id, "sealed")
        return json({ room: await view(loaded, u.id), verified: true })
      }
      case "verify": {
        const landed = await verifyRoom(loaded)
        if (loaded.room.status === "sealed" && loaded.room.tx_id) loaded = await markSealed(supabaseAdmin, loaded, loaded.room.tx_id, landed)
        return json({ landed, room: await view(loaded, u.id) })
      }
      default:
        return json({ error: "Unknown action.", code: "bad_request" }, 400)
    }
  } catch (e) {
    return failure(e, "POST")
  }
}
