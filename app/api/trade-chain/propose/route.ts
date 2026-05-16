// NEXT_STEPS — Off-chain entry point for the RPCTradeEscrow lifecycle.
// Wraps submitProposeTrade (§3a of RPCTradeEscrow_DEPLOYMENT.md) and
// writes the initial trade_chain_state row (§4). The Cadence contract is
// not yet deployed — submitProposeTrade is stubbed at
// lib/trade-escrow/fcl-submit.ts and returns a fake tx id today.

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { submitProposeTrade } from "@/lib/trade-escrow/fcl-submit";
import { collectionFromUuid, COLLECTION_META, type TradeCollection } from "@/lib/trade-escrow/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface PostBody {
  trade_match_id?: string;
}

// GET /api/trade-chain/propose?trade_match_id=... — reads the current
// trade_chain_state row for the given match. Used by the TradeChainPanel to
// poll status. Same resource as POST; same path; standard REST pairing.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const tradeMatchId = req.nextUrl.searchParams.get("trade_match_id")?.trim();
  if (!tradeMatchId) {
    return NextResponse.json({ error: "trade_match_id required" }, { status: 400 });
  }
  try {
    const { data: matchRow, error: matchErr } = await (supabaseAdmin as any)
      .from("trade_matches")
      .select("id, buyer_user_id, seller_user_id")
      .eq("id", tradeMatchId)
      .maybeSingle();
    if (matchErr) return NextResponse.json({ error: matchErr.message }, { status: 500 });
    if (!matchRow) return NextResponse.json({ error: "trade_match not found" }, { status: 404 });
    if (matchRow.buyer_user_id !== user.id && matchRow.seller_user_id !== user.id) {
      return NextResponse.json({ error: "Not a party to this trade_match" }, { status: 403 });
    }
    const { data: state, error: stateErr } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .select("*")
      .eq("trade_match_id", tradeMatchId)
      .maybeSingle();
    if (stateErr) return NextResponse.json({ error: stateErr.message }, { status: 500 });
    return NextResponse.json({ ok: true, state: state ?? null });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

interface OfferRow {
  id: string;
  user_id: string;
  wallet_address: string;
  moment_id: string;
  collection_id: string;
}

interface TradeMatchRow {
  id: string;
  buyer_user_id: string | null;
  seller_user_id: string | null;
  // Expected columns once the trade-chain feature is wired into matching.
  // The current schema (see app/api/trade-hub/matches/route.ts) has only
  // `offer_id` (singular). Trevor will add these two columns alongside the
  // trade_chain_state migration so trade_matches can reference one offer
  // per party. If they're missing the lookup below will fail loudly with a
  // clear error, which is the intended signal that the schema update is
  // pending.
  partya_offer_id: string | null;
  partyb_offer_id: string | null;
}

const TRADE_EXPIRY_MS = 60 * 60 * 1000;

export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const tradeMatchId = body.trade_match_id?.trim();
  if (!tradeMatchId) {
    return NextResponse.json({ error: "trade_match_id required" }, { status: 400 });
  }

  try {
    // 1. Look up the trade_match. The signed-in user must be one of the
    //    parties — guards against a stray client triggering a propose on
    //    someone else's match.
    const { data: matchRaw, error: matchErr } = await (supabaseAdmin as any)
      .from("trade_matches")
      .select("id, buyer_user_id, seller_user_id, partya_offer_id, partyb_offer_id")
      .eq("id", tradeMatchId)
      .maybeSingle();
    const matchRow = matchRaw as TradeMatchRow | null;
    if (matchErr) {
      return NextResponse.json({ error: matchErr.message }, { status: 500 });
    }
    if (!matchRow) {
      return NextResponse.json({ error: "trade_match not found" }, { status: 404 });
    }
    if (matchRow.buyer_user_id !== user.id && matchRow.seller_user_id !== user.id) {
      return NextResponse.json({ error: "Not a party to this trade_match" }, { status: 403 });
    }
    if (!matchRow.partya_offer_id || !matchRow.partyb_offer_id) {
      return NextResponse.json(
        {
          error:
            "trade_match is missing partya_offer_id / partyb_offer_id. The trade_matches table needs the two-offer columns added before propose can run — see RPCTradeEscrow_DEPLOYMENT.md §4.",
        },
        { status: 409 }
      );
    }

    // 2. Reject if a trade_chain_state already exists for this match. The
    //    table has UNIQUE(trade_match_id), so we'd hit a duplicate-key
    //    error on insert below anyway; this is a friendlier path.
    const { data: existing, error: existingErr } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .select("id, status")
      .eq("trade_match_id", tradeMatchId)
      .maybeSingle();
    if (existingErr) {
      return NextResponse.json({ error: existingErr.message }, { status: 500 });
    }
    if (existing) {
      return NextResponse.json(
        { error: `trade_chain_state already exists for this match (status=${existing.status})` },
        { status: 409 }
      );
    }

    // 3. Pull both user_trade_offers in one round-trip via .in().
    const { data: offers, error: offersErr } = await (supabaseAdmin as any)
      .from("user_trade_offers")
      .select("id, user_id, wallet_address, moment_id, collection_id")
      .in("id", [matchRow.partya_offer_id, matchRow.partyb_offer_id]);
    if (offersErr) {
      return NextResponse.json({ error: offersErr.message }, { status: 500 });
    }
    const offersList = (offers ?? []) as OfferRow[];
    const offerA = offersList.find((o) => o.id === matchRow.partya_offer_id);
    const offerB = offersList.find((o) => o.id === matchRow.partyb_offer_id);
    if (!offerA || !offerB) {
      return NextResponse.json({ error: "One or both user_trade_offers not found" }, { status: 404 });
    }

    // 4. Map each offer's collection UUID to a TradeCollection slug to get
    //    its nft_type identifier. Reject if either collection is outside
    //    the 5 supported by COLLECTION_META.
    const slugA: TradeCollection | null = collectionFromUuid(offerA.collection_id);
    const slugB: TradeCollection | null = collectionFromUuid(offerB.collection_id);
    if (!slugA || !slugB) {
      return NextResponse.json(
        { error: "One or both offers reference an unsupported collection UUID" },
        { status: 400 }
      );
    }

    const expiresAtDate = new Date(Date.now() + TRADE_EXPIRY_MS);
    const expiresAtIso = expiresAtDate.toISOString();
    const expiresAtUnixSec = Math.floor(expiresAtDate.getTime() / 1000).toString();

    // 5. Fire the on-chain propose (currently stubbed — returns a fake tx id
    //    and no chain_trade_id). When the contract is live this submitter
    //    must parse the TradeProposed event from the sealed tx and return
    //    the assigned chain_trade_id; the route should then store it on
    //    the row alongside propose_tx_id.
    const submitted = await submitProposeTrade({
      partyA: offerA.wallet_address,
      partyB: offerB.wallet_address,
      partyA_nft_type: COLLECTION_META[slugA].nft_type_identifier,
      partyB_nft_type: COLLECTION_META[slugB].nft_type_identifier,
      partyA_expected_ids: [offerA.moment_id],
      partyB_expected_ids: [offerB.moment_id],
      expires_at_unix_sec: expiresAtUnixSec,
    });

    // 6. Insert the trade_chain_state row. chain_trade_id is null until the
    //    propose tx is sealed and the TradeProposed event is parsed; the
    //    deposit-callback / execute routes will need to backfill it via
    //    the event-listener pipeline.
    const insertRow = {
      trade_match_id: tradeMatchId,
      chain_trade_id: null,
      partya_address: offerA.wallet_address,
      partyb_address: offerB.wallet_address,
      partya_nft_type: COLLECTION_META[slugA].nft_type_identifier,
      partyb_nft_type: COLLECTION_META[slugB].nft_type_identifier,
      partya_expected_ids: [Number(offerA.moment_id)],
      partyb_expected_ids: [Number(offerB.moment_id)],
      expires_at: expiresAtIso,
      propose_tx_id: submitted.tx_id,
      status: "proposed" as const,
    };

    const { data: inserted, error: insertErr } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .insert(insertRow)
      .select("*")
      .maybeSingle();
    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, state: inserted });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[trade-chain/propose] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
