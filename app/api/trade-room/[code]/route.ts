// app/api/trade-room/[code]/route.ts
//
// One trade room (Trevor, 2026-10-31: user-to-user Top Shot trades, two signatures
// on one transaction, no custody). Signed in only; every mutation is scoped to the
// caller's OWN side. RPC never holds a key, a moment or a fee.
//
//   GET                        -> { room: RoomView }   (a room the caller may join is visible to them)
//   GET ?relay=<id>            -> { relay }            the initiator polling for the co-signature
//   GET ?picker=1&q=<player>   -> { picker }           the caller's source account's indexed moments
//   GET ?nonce=1               -> { nonce, issuedAt }  for Flow Wallet's account proof
//   POST { action, ... }:
//     join                                 -> the caller becomes side B
//     wallet   { proof, source? }          -> prove a Flow Wallet; list its accounts; with `source`, save both
//     items    { ids }                     -> this side gives these moments (chain-checked: held + unlocked)
//     accept   { version, notice_read }    -> accept the proposal as seen
//     unaccept                             -> withdraw an acceptance
//     cancel   { reason? }                 -> either side, any time before the seal
//     simulate                             -> the whole swap simulated on mainnet (a READ; always allowed)
//     relay_post { cosigner, signable }    -> ⛔ gated by RPC_TRADE_ROOM_EXECUTE: asks the other wallet to sign
//     relay_sign { id, signature, key_id } -> the co-signer's signature
//     signing_ended                        -> the initiator reports a signing attempt that did not seal
//     sealed   { tx_id }                   -> record the seal, read the chain for where each moment is
//     verify                               -> read the chain again (after a seal)
//
// Three outcomes, never two: a check that fails names what failed; a chain that
// could not be asked answers 503 + retryable, never "not held" or "not yours".

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { FlowScriptError } from "@/lib/giveaways/flow-script"
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
  setItems,
  setWallet,
  sideOf,
  asTradeRoomError,
  TradeRoomError,
  unaccept,
  type LoadedRoom,
  type SideRow,
} from "@/lib/trade-room/store"
import { checkPicks, EXECUTE_CLOSED_MESSAGE, executionOpen, planRoom, verifyRoom } from "@/lib/trade-room/execute"
import { pickItems, readPicker } from "@/lib/trade-room/holdings"
import { buildRoomView, cosignerOf, usernamesFor, type PendingRelay } from "@/lib/trade-room/view"

export const dynamic = "force-dynamic"
// a simulation makes several Flow script calls (20 s bound each)
export const maxDuration = 60

const NO_STORE = { "Cache-Control": "no-store" }
const RELAY_TABLE = "trade_room_relay" as const
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
  const [names, relay] = await Promise.all([usernamesFor(supabaseAdmin, loaded.sides.map((s) => s.user_id)), pendingRelayFor(loaded, me)])
  return buildRoomView(loaded, userId, names, { relay })
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
    if (sp.has("picker")) {
      const side = mySide(loaded, u.id)
      if (!side.source) throw new TradeRoomError("Connect and prove your Flow Wallet first.", 409, "no_wallet")
      return json({ picker: await readPicker(supabaseAdmin, side.source, sp.get("q")) })
    }
    // a stranger may look at an open room (that is how they join); a finished or full
    // room they are not part of is not theirs to read
    if (!me && !(loaded.room.status === "open" && loaded.sides.length < 2)) throw new TradeRoomError("No such trade.", 404, "not_found")
    return json({ room: await view(loaded, u.id) })
  } catch (e) {
    return failure(e, "GET")
  }
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
      loaded = await joinRoom(supabaseAdmin, loaded, u.id)
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
        if (!accounts.some((a) => a.address === source && a.topshot_count != null)) {
          throw new TradeRoomError("That account has no Top Shot collection, so it can't give or receive Moments.", 409, "no_collection")
        }
        loaded = await setWallet(supabaseAdmin, loaded, me, out.address, source)
        return json({ room: await view(loaded, u.id), signer: out.address, accounts })
      }
      case "items": {
        if (!me.source) throw new TradeRoomError("Connect and prove your Flow Wallet before picking Moments.", 409, "no_wallet")
        const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x).trim()).filter(Boolean) : []
        const picker = await readPicker(supabaseAdmin, me.source)
        const { items, unknown } = pickItems(picker.rows, ids)
        if (unknown.length) throw new TradeRoomError(`RPC hasn't indexed ${unknown.join(", ")} for that account yet.`, 409, "not_indexed")
        await checkPicks(me.source, ids)
        loaded = await setItems(supabaseAdmin, loaded, me, items)
        return json({ room: await view(loaded, u.id) })
      }
      case "accept":
        loaded = await accept(supabaseAdmin, loaded, me, Number(body.version), body.notice_read === true)
        return json({ room: await view(loaded, u.id) })
      case "unaccept":
        loaded = await unaccept(supabaseAdmin, loaded, me)
        return json({ room: await view(loaded, u.id) })
      case "cancel":
        loaded = await cancelRoom(supabaseAdmin, loaded, u.id, typeof body.reason === "string" ? body.reason : null)
        return json({ room: await view(loaded, u.id) })
      case "simulate":
        return json({ plan: await planRoom(loaded, me.side) })
      case "relay_post": {
        if (!executionOpen()) throw new TradeRoomError(EXECUTE_CLOSED_MESSAGE, 503, "execute_closed")
        const cosigner = typeof body.cosigner === "string" ? body.cosigner.trim().toLowerCase() : ""
        const other = cosignerOf(loaded, me.side)
        if (!other?.signer || other.signer !== cosigner) throw new TradeRoomError("The co-signer must be the other side's proven wallet.", 400, "wrong_cosigner")
        await markSigning(supabaseAdmin, loaded)
        const id = await postSignable(supabaseAdmin, cosigner, body.signable, Date.now(), { table: RELAY_TABLE, extra: { room_id: loaded.room.id } })
        return json({ id })
      }
      case "relay_sign": {
        const id = String(body.id ?? "")
        const relay = await getRelay(supabaseAdmin, id, Date.now(), RELAY_TABLE)
        if (relay.room_id !== loaded.room.id || relay.cosigner !== me.signer) throw new TradeRoomError("This signing request isn't addressed to your wallet.", 403, "wrong_cosigner")
        await postSignature(supabaseAdmin, id, body.signature, body.key_id, Date.now(), RELAY_TABLE)
        return json({ ok: true })
      }
      case "signing_ended":
        await markSigningEnded(supabaseAdmin, loaded)
        return json({ room: await view(await loadRoom(supabaseAdmin, code), u.id) })
      case "sealed": {
        const txId = typeof body.tx_id === "string" ? body.tx_id.trim().toLowerCase().replace(/^0x/, "") : ""
        let landed: unknown = null
        try {
          landed = await verifyRoom(loaded)
        } catch {
          // the seal is a fact the initiator saw; a failed read is reported as unverified, never as "not landed"
          landed = null
        }
        loaded = await markSealed(supabaseAdmin, loaded, txId, landed)
        return json({ room: await view(loaded, u.id), verified: landed != null })
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
