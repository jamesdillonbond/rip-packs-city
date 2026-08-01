// Client-side helper for the cancelling party's signature.
//
// A trade can be cancelled by either party before it settles. The cancelling
// party signs the cancel template with their own wallet, then this helper
// reports the tx id to /api/trade-chain/cancel-callback, which flips
// trade_chain_state.status to 'cancelled'.
//
// Mirror of lib/trade-escrow/sign-deposit.ts. It inlines the cancel template
// (lib/trade-escrow/cadence.ts) and signs via fcl.mutate with the canceller's
// wallet (FCL supplies proposer/payer/authorizer on the client).
//
// ⚠ UNVERIFIED AGAINST A DEPLOYED CONTRACT — MUST TESTNET DRY-RUN FIRST.
// RPCTradeEscrow is not on Flow mainnet; see the banner in cadence.ts. This
// path is inert until NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS is set AND the
// Trade Hub surface is un-shelved (it notFound()s / 503s in production today).

"use client";

import * as fcl from "@onflow/fcl";
import * as t from "@onflow/types";
import { cancelTradeCadence } from "./cadence";

export interface SignCancelArgs {
  trade_match_id: string;
  chain_trade_id: number;
  side: "A" | "B";
  canceller_address: string;
  reason?: string;
}

export interface SignCancelResult {
  ok: boolean;
  tx_id: string;
  state?: unknown;
  error?: string;
}

function escrowAddress(): string {
  const addr = process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS;
  if (!addr) {
    throw new Error("Trade Hub is not available yet (NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS unset).");
  }
  return addr;
}

export async function signAndSubmitCancel(args: SignCancelArgs): Promise<SignCancelResult> {
  let tx_id = "";
  try {
    const cadence = cancelTradeCadence(escrowAddress());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx_id = await (fcl.mutate as any)({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any) => [
        arg(String(args.chain_trade_id), t.UInt64),
        arg(args.reason ?? "user_cancelled", t.String),
      ],
      limit: 9999,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sealed: any = await (fcl.tx(tx_id) as any).onceSealed();
    if (sealed?.errorMessage) {
      return { ok: false, tx_id, error: `cancel reverted: ${sealed.errorMessage}` };
    }
  } catch (err) {
    return { ok: false, tx_id, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    const res = await fetch("/api/trade-chain/cancel-callback", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trade_match_id: args.trade_match_id,
        cancelled_by: args.canceller_address,
        cancel_tx_id: tx_id,
        reason: args.reason,
      }),
    });
    const j = (await res.json()) as { ok?: boolean; state?: unknown; error?: string };
    if (!res.ok || j.error) {
      return { ok: false, tx_id, error: j.error ?? `HTTP ${res.status}` };
    }
    return { ok: true, tx_id, state: j.state };
  } catch (err) {
    return {
      ok: false,
      tx_id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
