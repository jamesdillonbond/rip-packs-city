// Frontend reports a filed cancellation tx id here after the cancelling party
// signs the §3d cancel_trade.cdc Cadence template via FCL (see
// lib/trade-escrow/sign-cancel.ts). This flips trade_chain_state.status to
// 'cancelled' and stores the cancel tx id.
//
// When the contract is live, this route should also verify the tx via Flow REST
// and parse the TradeCancelled event before flipping status; today (stub mode)
// we trust the client-reported tx id — the same posture as deposit-callback.

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import type { ChainTradeStatus, TradeChainState } from "@/lib/trade-escrow/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface PostBody {
  trade_match_id?: string;
  cancelled_by?: string;
  cancel_tx_id?: string;
  reason?: string;
}

// A trade can be cancelled at any point before it settles or reaches another
// terminal state. Once executed/cancelled/expired/failed it is immutable.
const CANCELLABLE_FROM: ReadonlySet<ChainTradeStatus> = new Set([
  "proposed",
  "partial_a",
  "partial_b",
  "ready",
]);

export async function POST(req: NextRequest) {
  if (!process.env.RPC_TRADE_ESCROW_ADDRESS) {
    return NextResponse.json({ error: "Trade Hub is not available yet." }, { status: 503 });
  }
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
  const cancelledBy = body.cancelled_by?.trim().toLowerCase();
  const cancelTxId = body.cancel_tx_id?.trim();
  const reason = body.reason?.trim() || null;
  if (!tradeMatchId || !cancelledBy || !cancelTxId) {
    return NextResponse.json(
      { error: "trade_match_id, cancelled_by, cancel_tx_id all required" },
      { status: 400 }
    );
  }

  try {
    const { data: currentRaw, error: currentErr } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .select("*")
      .eq("trade_match_id", tradeMatchId)
      .maybeSingle();
    const current = currentRaw as TradeChainState | null;
    if (currentErr) {
      return NextResponse.json({ error: currentErr.message }, { status: 500 });
    }
    if (!current) {
      return NextResponse.json({ error: "trade_chain_state not found" }, { status: 404 });
    }

    // Only a party to the trade may cancel it.
    const parties = [current.partya_address.toLowerCase(), current.partyb_address.toLowerCase()];
    if (!parties.includes(cancelledBy)) {
      return NextResponse.json(
        { error: "cancelled_by is not a party to this trade" },
        { status: 403 }
      );
    }

    // Idempotent no-op if already cancelled with the same tx.
    if (current.status === "cancelled" && current.cancel_tx_id === cancelTxId) {
      return NextResponse.json({ ok: true, state: current });
    }
    if (!CANCELLABLE_FROM.has(current.status)) {
      return NextResponse.json(
        { error: `Cannot cancel from status='${current.status}'` },
        { status: 409 }
      );
    }

    const patch: Record<string, unknown> = {
      status: "cancelled" as ChainTradeStatus,
      cancel_tx_id: cancelTxId,
      updated_at: new Date().toISOString(),
    };
    if (reason) patch.failure_reason = reason;

    const { data: updated, error: updateErr } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .update(patch)
      .eq("id", current.id)
      .select("*")
      .maybeSingle();
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, state: updated });
  } catch (err) {
    Sentry.captureException(err);
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[trade-chain/cancel-callback] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
