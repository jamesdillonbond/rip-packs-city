// app/api/trade-block/route.ts
//
// The Trade Block, signed in (Trevor, 2026-11-02; docs/strategy/features/trading.md §3).
// Public reads live under /api/public/trade-block; everything a user DOES lives here.
//
//   GET                         -> { wallets, listings, proposals: { sent, received } }   the caller's block
//   GET ?nonce=1                -> { nonce, issuedAt }                                    for a Flow Wallet account proof
//   GET ?holdings=1&collection=&q= -> { holdings }                                       assets in the caller's proven accounts
//   POST { action, ... }:
//     wallet   { proof, source? }        -> prove a Flow Wallet; list its accounts; with `source`, save it
//     create   { offers, wants, note, open_to_offers } -> post a listing
//     close    { code }                  -> close the caller's listing (pending proposals are declined)
//     propose  { code, give, get, note } -> propose a trade on someone's listing
//     decide   { proposal, accept }      -> the lister accepts (opens a trade room when all Top Shot) or declines
//     withdraw { proposal }              -> the proposer withdraws
//
// Three outcomes, never two: a refusal names what failed; a read or chain call that could
// not be made answers 503 + retryable, never "holds nothing" or "not yours". No response
// ever carries another user's wallet address.

import { NextRequest, NextResponse, after } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { requireUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { FlowScriptError } from "@/lib/giveaways/flow-script"
import { discoverAccounts } from "@/lib/giveaways/linked-accounts"
import { issueClaimNonce, verifyClaimProof, type ClaimProofInput } from "@/lib/giveaways/claim-proof"
import { usernamesFor } from "@/lib/trade-room/view"
import { collectionBySlug, FLOW_ADDRESS_RE } from "@/lib/trade-block/rules"
import {
  closeListing,
  createListing,
  decide,
  listingsByIds,
  listingsOf,
  loadListing,
  propose,
  proposalsFor,
  provenAccounts,
  readHoldings,
  saveProvenAccount,
  stillIndexed,
  TradeBlockError,
  withdraw,
} from "@/lib/trade-block/store"
import { listingView, proposalView } from "@/lib/trade-block/view"
import { notifyBlock, type BlockNotice } from "@/lib/trade-block/notify"

export const dynamic = "force-dynamic"
export const maxDuration = 30

const NO_STORE = { "Cache-Control": "no-store" }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

function failure(e: unknown, where: string): NextResponse {
  if (e instanceof FlowScriptError) return json({ error: "We couldn't reach the Flow blockchain. Try again in a minute.", code: "upstream_unavailable", retryable: true }, 503)
  if (e instanceof TradeBlockError) return json({ error: e.copy, code: e.code, retryable: e.status >= 500 }, e.status)
  // the linked-accounts lookup's own shape errors: fixed copy (the leak guards key on .message)
  if (e instanceof Error && e.name === "GiveawayError") {
    console.error("[api/trade-block] linked-accounts lookup:", e.message)
    return json({ error: "We couldn't read your wallet's linked accounts from the Flow blockchain. Try again in a minute.", code: "flow_shape", retryable: true }, 502)
  }
  return apiErrorResponse(e, `api/trade-block ${where}`, "The Trade Block couldn't do that just now. Try again in a moment.")
}

async function currentUser() {
  try {
    return await requireUser()
  } catch (e) {
    if (e instanceof Response) return e
    throw e
  }
}

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
export function __resetTradeBlockProofRateLimit() {
  proofHits.clear()
}

function notifyLater(to: string, actor: string, notice: BlockNotice, roomCode?: string | null) {
  const run = () => notifyBlock(supabaseAdmin, to, actor, notice, { roomCode })
  try {
    after(run)
  } catch {
    void run()
  }
}

async function myBlock(userId: string, now = Date.now()) {
  const [wallets, listings] = await Promise.all([provenAccounts(supabaseAdmin, userId), listingsOf(supabaseAdmin, userId)])
  const proposals = await proposalsFor(supabaseAdmin, userId, listings.map((l) => l.listing.id))
  const allProps = [...proposals.sent, ...proposals.received]
  const listingRows = await listingsByIds(supabaseAdmin, allProps.map((p) => p.proposal.listing_id))
  const people = new Set<string>([userId])
  for (const p of allProps) {
    people.add(p.proposal.user_id)
    const l = listingRows.get(p.proposal.listing_id)
    if (l) people.add(l.user_id)
  }
  const names = await usernamesFor(supabaseAdmin, [...people])
  const offered = listings.flatMap((l) => l.items.filter((i) => i.role === "offer"))
  const inIndex = await stillIndexed(supabaseAdmin, offered)
  return {
    // the caller's OWN accounts only — never another user's
    wallets: wallets.map((w) => ({ source: w.source, signer: w.signer, proven_at: w.proven_at })),
    listings: listings.map((l) => listingView(l, names, userId, now, inIndex)),
    proposals: {
      sent: proposals.sent.map((p) => {
        const l = listingRows.get(p.proposal.listing_id)
        return proposalView(p, { direction: "sent", counterparty: (l && names.get(l.user_id)) ?? "", listingCode: l?.code ?? null })
      }),
      received: proposals.received.map((p) =>
        proposalView(p, { direction: "received", counterparty: names.get(p.proposal.user_id) ?? "", listingCode: listingRows.get(p.proposal.listing_id)?.code ?? null }),
      ),
    },
  }
}

export async function GET(req: NextRequest) {
  const u = await currentUser()
  if (u instanceof Response) return u
  const sp = req.nextUrl.searchParams
  try {
    if (sp.has("nonce")) return json(issueClaimNonce(u.id))
    if (sp.has("holdings")) {
      const accounts = await provenAccounts(supabaseAdmin, u.id)
      if (accounts.length === 0) return json({ holdings: { indexed: false, proven: false, rows: [], truncated: false } })
      const slug = sp.get("collection")
      const c = slug ? collectionBySlug(slug) : null
      if (slug && !c) throw new TradeBlockError("Unknown collection.", 400, "bad_collection")
      const h = await readHoldings(supabaseAdmin, accounts.map((a) => a.source), { collectionId: c?.id ?? null, q: sp.get("q") })
      // the caller's own accounts: `source` stays so the picker can show which account
      return json({ holdings: { ...h, proven: true } })
    }
    return json(await myBlock(u.id))
  } catch (e) {
    return failure(e, "GET")
  }
}

export async function POST(req: NextRequest) {
  const u = await currentUser()
  if (u instanceof Response) return u
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return json({ error: "Body must be JSON.", code: "bad_request" }, 400)
  }
  try {
    const action = String(body?.action ?? "")
    switch (action) {
      case "wallet": {
        if (proofRateLimited(u.id)) return json({ error: "Too many tries. Wait a minute and try again.", code: "rate_limited" }, 429)
        const out = await verifyClaimProof(u.id, req.nextUrl.origin, body.proof as ClaimProofInput | null)
        if (!out.ok) return json({ error: out.error, code: out.code }, 400)
        const accounts = (await discoverAccounts(out.address)).map((a) => ({ address: a.address, role: a.role, name: a.name, dapper: a.dapper }))
        const source = typeof body.source === "string" ? body.source.trim().toLowerCase() : ""
        if (!source) return json({ signer: out.address, accounts })
        if (!FLOW_ADDRESS_RE.test(source) || !accounts.some((a) => a.address === source)) {
          throw new TradeBlockError("Pick an account this wallet owns or links.", 400, "bad_source")
        }
        await saveProvenAccount(supabaseAdmin, u.id, out.address, source)
        return json({ saved: true, ...(await myBlock(u.id)) })
      }
      case "create": {
        const loaded = await createListing(supabaseAdmin, u.id, body)
        const names = await usernamesFor(supabaseAdmin, [u.id])
        return json({ listing: listingView(loaded, names, u.id, Date.now(), null) }, 201)
      }
      case "close": {
        await closeListing(supabaseAdmin, u.id, String(body.code ?? ""))
        return json(await myBlock(u.id))
      }
      case "propose": {
        const code = String(body.code ?? "")
        const p = await propose(supabaseAdmin, u.id, code, body)
        const listing = await loadListing(supabaseAdmin, code)
        notifyLater(listing.listing.user_id, u.id, "proposal")
        const names = await usernamesFor(supabaseAdmin, [listing.listing.user_id])
        return json({ proposal: proposalView(p, { direction: "sent", counterparty: names.get(listing.listing.user_id) ?? "", listingCode: code }) }, 201)
      }
      case "decide": {
        const accept = body.accept === true
        const out = await decide(supabaseAdmin, u.id, String(body.proposal ?? ""), accept)
        notifyLater(out.proposal.proposal.user_id, u.id, accept ? "accepted" : "declined", out.room_code)
        return json({ room_code: out.room_code, unsignable: out.unsignable, ...(await myBlock(u.id)) })
      }
      case "withdraw": {
        await withdraw(supabaseAdmin, u.id, String(body.proposal ?? ""))
        return json(await myBlock(u.id))
      }
      default:
        return json({ error: "Unknown action.", code: "bad_request" }, 400)
    }
  } catch (e) {
    return failure(e, "POST")
  }
}
