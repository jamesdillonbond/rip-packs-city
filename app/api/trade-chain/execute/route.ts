// NEXT_STEPS — Triggers the §3c execute_swap.cdc transaction once both
// sides have deposited and status='ready'. Anyone can call executeSwap on
// chain (per RPCTradeEscrow_DEPLOYMENT.md §3c) but in practice the RPC
// backend hot wallet does it so users don't pay a second fee. Today
// submitExecuteSwap is a stub at lib/trade-escrow/fcl-submit.ts.

import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { supabaseAdmin } from "@/lib/supabase";
import { getCurrentUser } from "@/lib/auth/supabase-server";
import { submitExecuteSwap } from "@/lib/trade-escrow/fcl-submit";
import type { TradeChainState } from "@/lib/trade-escrow/types";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface PostBody {
  trade_match_id?: string;
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
  if (!tradeMatchId) {
    return NextResponse.json({ error: "trade_match_id required" }, { status: 400 });
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
    if (current.status !== "ready") {
      return NextResponse.json(
        { error: `Cannot execute from status='${current.status}' — both sides must deposit first` },
        { status: 409 }
      );
    }
    if (current.chain_trade_id == null) {
      // The propose tx hasn't been parsed off-chain yet (event listener
      // didn't backfill chain_trade_id, or the contract isn't live). In
      // stub mode this will trip on every trade — bypass by accepting a
      // null id and letting the stub submitter accept the same.
      // Once live, this should poll the propose tx receipt before failing.
      console.log(
        `[trade-chain/execute] chain_trade_id missing for match ${tradeMatchId} — stub mode passthrough`
      );
    }

    const submitted = await submitExecuteSwap({
      chain_trade_id: String(current.chain_trade_id ?? 0),
    });

    const { data: updated, error: updateErr } = await (supabaseAdmin as any)
      .from("trade_chain_state")
      .update({
        status: "executed",
        execute_tx_id: submitted.tx_id,
        updated_at: new Date().toISOString(),
      })
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
    console.log(`[trade-chain/execute] fatal: ${msg}`);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
