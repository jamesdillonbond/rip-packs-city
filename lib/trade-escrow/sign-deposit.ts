// Client-side helper for the user's deposit signature.
//
// The trade-chain pipeline is split:
//   - propose / execute / reclaim are signed by the RPC backend hot wallet
//     in lib/trade-escrow/fcl-submit.ts
//   - deposit is signed by the USER's own wallet via FCL in this file
//
// It inlines the universal deposit template (lib/trade-escrow/cadence.ts,
// parameterised by the collection's storage/public paths), signs it with the
// connected wallet via fcl.mutate (FCL supplies proposer/payer/authorizer on
// the client), then reports the tx id to /api/trade-chain/deposit-callback.
//
// ⚠ UNVERIFIED AGAINST A DEPLOYED CONTRACT — MUST TESTNET DRY-RUN FIRST.
// RPCTradeEscrow is not on Flow mainnet; see the banner in cadence.ts. This
// path is inert until NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS is set AND the
// Trade Hub surface is un-shelved (it notFound()s / 503s in production today).
//
// The contract address is read from NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS
// (client env) — the server-only RPC_TRADE_ESCROW_ADDRESS is not visible in the
// browser, so both must be set to the same value at go-live.

"use client";

import * as fcl from "@onflow/fcl";
import * as t from "@onflow/types";
import { COLLECTION_META, type TradeCollection } from "./types";
import { depositToTradeCadence } from "./cadence";

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

function escrowAddress(): string {
  const addr = process.env.NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS;
  if (!addr) {
    throw new Error("Trade Hub is not available yet (NEXT_PUBLIC_RPC_TRADE_ESCROW_ADDRESS unset).");
  }
  return addr;
}

export async function signAndSubmitDeposit(args: SignDepositArgs): Promise<SignDepositResult> {
  const meta = COLLECTION_META[args.collection];
  const incoming = COLLECTION_META[args.incoming_collection];

  let tx_id = "";
  try {
    const cadence = depositToTradeCadence(
      escrowAddress(),
      meta.storage_path,
      meta.public_path,
      incoming.public_path
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tx_id = await (fcl.mutate as any)({
      cadence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args: (arg: any) => [
        arg(String(args.chain_trade_id), t.UInt64),
        arg(args.nft_ids, t.Array(t.UInt64)),
      ],
      limit: 9999,
    });
    // Wait for the deposit to seal before reporting it, so the callback flips
    // status only once the NFTs are actually escrowed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sealed: any = await (fcl.tx(tx_id) as any).onceSealed();
    if (sealed?.errorMessage) {
      return { ok: false, tx_id, error: `deposit reverted: ${sealed.errorMessage}` };
    }
  } catch (err) {
    return { ok: false, tx_id, error: err instanceof Error ? err.message : String(err) };
  }

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
