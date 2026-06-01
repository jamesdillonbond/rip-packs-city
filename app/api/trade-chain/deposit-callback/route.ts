// NEXT_STEPS — Frontend reports a sealed deposit tx id here after the user
// signs the §3b deposit_to_trade_<col>.cdc Cadence template via FCL.
// When the contract is live, this route should also verify the tx via
// Flow REST and parse the TradeDeposited event before flipping status;
// today (stub mode) we trust the client-reported tx id.

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import type { ChainTradeStatus, TradeChainState } from "@/lib/trade-escrow/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface PostBody {
  trade_match_id?: string;
  depositor_address?: string;
  deposit_tx_id?: string;
  side?: "A" | "B";
}

// State-machine transition table for a single deposit. The propose route
// inserts status='proposed'; each side's deposit advances toward 'ready'.
function nextStatus(current: ChainTradeStatus, side: "A" | "B"): ChainTradeStatus | null {
  if (side === "A") {
    if (current === "proposed") return "partial_a";
    if (current === "partial_b") return "ready";
    return null;
  }
  if (side === "B") {
    if (current === "proposed") return "partial_b";
    if (current === "partial_a") return "ready";
    return null;
  }
  return null;
}

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
  const depositorAddress = body.depositor_address?.trim().toLowerCase();
  const depositTxId = body.deposit_tx_id?.trim();
  const side = body.side;
  if (!tradeMatchId || !depositorAddress || !depositTxId || (side !== "A" && side !== "B")) {
    return NextResponse.json(
      { error: "trade_match_id, depositor_address, deposit_tx_id, side(A|B) all required" },
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

    // Confirm the depositor address actually matches the side they claim.
    const expectedAddr = side === "A" ? current.partya_address : current.partyb_address;
    if (expectedAddr.toLowerCase() !== depositorAddress) {
      return NextResponse.json(
        { error: `depositor_address does not match party ${side}` },
        { status: 403 }
      );
    }

    // Reject double-deposits on the same side.
    const existingTx = side === "A" ? current.partya_deposit_tx_id : current.partyb_deposit_tx_id;
    if (existingTx) {
      return NextResponse.json(
        { error: `Party ${side} has already deposited (tx ${existingTx})` },
        { status: 409 }
      );
    }

    const next = nextStatus(current.status, side);
    if (!next) {
      return NextResponse.json(
        { error: `Cannot deposit from status='${current.status}' on side=${side}` },
        { status: 409 }
      );
    }

    const patch: Record<string, unknown> = {
      status: next,
      updated_at: new Date().toISOString(),
    };
    if (side === "A") patch.partya_deposit_tx_id = depositTxId;
    else patch.partyb_deposit_tx_id = depositTxId;

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
    console.log(`[trade-chain/deposit-callback] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
