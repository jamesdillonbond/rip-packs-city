// Client-side helper for the cancelling party's signature.
//
// A trade can be cancelled by either party before it settles. The cancelling
// party signs the §3d cancel_trade.cdc Cadence template with their own wallet,
// then this helper reports the tx id to /api/trade-chain/cancel-callback, which
// flips trade_chain_state.status to 'cancelled'.
//
// Today this is a STUB — the mirror of lib/trade-escrow/sign-deposit.ts. It
// waits briefly (so the UI can show a "signing…" state) and POSTs a fake tx id.
//
// When wired live:
//   - inline the §3d cancel_trade.cdc Cadence template from
//     RPCTradeEscrow_DEPLOYMENT.md
//   - call `fcl.mutate({ cadence, args, limit: 9999 })` with the canceller's
//     wallet as proposer/payer/authorizer (FCL handles this on the client)
//   - await the transaction id, then POST to cancel-callback
//   - encode UInt64 args as `String(v)` per RPC_DESIGN_SYSTEM.md §8

"use client";

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

async function fakeWalletSign(ms: number): Promise<void> {
  // Stand-in for `await fcl.mutate(...)`. Long enough to see the "signing…" UI
  // state but short enough to not annoy during dev.
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stubTxId(): string {
  return `0xstub_cancel_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function signAndSubmitCancel(args: SignCancelArgs): Promise<SignCancelResult> {
  // Surface the chosen template in the console so the dev wiring is visible
  // during stub mode. Mirror of the server-side logCall in
  // lib/trade-escrow/fcl-submit.ts and the client logging in sign-deposit.ts.
  // eslint-disable-next-line no-console
  console.log("[trade-escrow:sign-cancel:stub]", {
    template: "cancel_trade.cdc",
    side: args.side,
    chain_trade_id: args.chain_trade_id,
    canceller_address: args.canceller_address,
  });

  await fakeWalletSign(1500);
  const tx_id = stubTxId();

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
