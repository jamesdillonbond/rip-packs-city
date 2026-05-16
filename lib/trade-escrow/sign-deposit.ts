// NEXT_STEPS — Client-side helper for the user's deposit signature.
//
// The trade-chain pipeline is split:
//   - propose / execute / reclaim are signed by the RPC backend hot wallet
//     in lib/trade-escrow/fcl-submit.ts
//   - deposit is signed by the USER's own wallet via FCL in this file
//
// Today this is a STUB. It waits 2 seconds (so the UI can show a "signing…"
// state) and then POSTs a fake tx id to /api/trade-chain/deposit-callback.
//
// When wired live:
//   - inline the §3b deposit_to_trade_<collection>.cdc Cadence template
//     from RPCTradeEscrow_DEPLOYMENT.md, choosing by `args.collection`
//   - call `fcl.mutate({ cadence, args, limit: 9999 })` with the user's
//     wallet as proposer/payer/authorizer (FCL handles this on the client)
//   - await the transaction id, then POST to deposit-callback
//   - replace COLLECTION_META.public_path lookups with values from §3b
//   - encode UInt64 args as `String(v)` per RPC_DESIGN_SYSTEM.md §8

"use client";

import { COLLECTION_META, type TradeCollection } from "./types";

export interface SignDepositArgs {
  trade_match_id: string;
  chain_trade_id: number;
  side: "A" | "B";
  depositor_address: string;
  collection: TradeCollection;
  incoming_collection: TradeCollection;
  nft_ids: string[];
}

export interface SignDepositResult {
  ok: boolean;
  tx_id: string;
  state?: unknown;
  error?: string;
}

async function fakeWalletSign(ms: number): Promise<void> {
  // Stand-in for `await fcl.mutate(...)`. Two seconds is long enough to see
  // the "signing…" UI state but short enough to not annoy during dev.
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function stubTxId(): string {
  return `0xstub_deposit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function signAndSubmitDeposit(args: SignDepositArgs): Promise<SignDepositResult> {
  // Surface the chosen template + paths in the console so the dev wiring is
  // visible during stub mode. Mirror of the server-side logCall in
  // lib/trade-escrow/fcl-submit.ts.
  const meta = COLLECTION_META[args.collection];
  const incoming = COLLECTION_META[args.incoming_collection];
  // eslint-disable-next-line no-console
  console.log("[trade-escrow:sign-deposit:stub]", {
    template: `deposit_to_trade_${args.collection}.cdc`,
    storage_path: meta.storage_path,
    incoming_public_path: incoming.public_path,
    side: args.side,
    chain_trade_id: args.chain_trade_id,
    nft_ids: args.nft_ids,
  });

  await fakeWalletSign(2000);
  const tx_id = stubTxId();

  try {
    const res = await fetch("/api/trade-chain/deposit-callback", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        trade_match_id: args.trade_match_id,
        depositor_address: args.depositor_address,
        deposit_tx_id: tx_id,
        side: args.side,
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
