// Backend FCL submitter for RPCTradeEscrow.
//
// propose / execute / reclaim are signed by the RPC hot wallet (the backend
// pays gas so users don't). deposit / cancel are normally signed by the USER's
// own wallet on the client (lib/trade-escrow/sign-deposit.ts + sign-cancel.ts);
// the hot-wallet server versions of those two below exist ONLY for testnet
// smoke-testing the wiring with a synthetic depositor — do NOT call them from
// production routes.
//
// ⚠ UNVERIFIED AGAINST A DEPLOYED CONTRACT — MUST TESTNET DRY-RUN FIRST.
// RPCTradeEscrow is not on Flow mainnet, so the mandated Cadence-MCP-against-
// mainnet verification (CLAUDE.md "Cadence Work") could not be run. Every
// submitter is gated by ensureLive(): it throws unless RPC_TRADE_ESCROW_ADDRESS
// is set, and the whole Trade Hub surface 503s / notFound()s in production
// today, so this path is inert until the contract is deployed AND the env var
// is set. Before that flip: deploy to testnet, set the env to the testnet
// address, and dry-run all five verbs end-to-end. Template source + grounding
// is in lib/trade-escrow/cadence.ts.
//
// Signing reuses the verified hot-wallet FCL authorization from
// lib/breaks/server-authz.ts (ECDSA_secp256k1 + SHA2_256, on-chain-verified).
//
// Signatures here are FINAL — the API routes call these as-written.

import * as fcl from "@onflow/fcl";
import * as t from "@onflow/types";
import { configureFcl, buildHotWalletAuthz } from "@/lib/breaks/server-authz";
import {
  proposeTradeCadence,
  depositToTradeCadence,
  executeSwapCadence,
  cancelTradeCadence,
  reclaimExpiredCadence,
} from "./cadence";
import {
  COLLECTION_META,
  type CancelTradeArgs,
  type DepositToTradeArgs,
  type ExecuteSwapArgs,
  type ProposeTradeArgs,
  type ReclaimExpiredArgs,
  type SubmittedTx,
  type TradeCollection,
} from "./types";

function contractAddress(): string {
  return process.env.RPC_TRADE_ESCROW_ADDRESS ?? "<unset>";
}

// RPCTradeEscrow is on-chain swapping infrastructure that is NOT yet deployed.
// Until RPC_TRADE_ESCROW_ADDRESS is set every submitter hard-fails loudly here
// rather than broadcasting a transaction against a non-existent contract. Same
// shelved-until-real posture as Cart (CLAUDE.md Open #1).
function ensureLive(verb: string): string {
  const addr = process.env.RPC_TRADE_ESCROW_ADDRESS;
  if (!addr || addr === "<unset>") {
    throw new Error(
      `Trade escrow unavailable: RPCTradeEscrow contract not deployed (${verb}). Set RPC_TRADE_ESCROW_ADDRESS to enable.`
    );
  }
  return addr;
}

function logCall(verb: string, payload: unknown) {
  console.log(
    `[trade-escrow] ${verb} contract=${contractAddress()} payload=${JSON.stringify(payload)}`
  );
}

// UInt64 / UFix64 Cadence args must be strings; UFix64 additionally requires a
// decimal point (per RPC_DESIGN_SYSTEM.md §8). A unix-seconds integer string
// like "1712345678" becomes "1712345678.0".
function toUFix64(intSecs: string): string {
  const s = String(intSecs).trim();
  if (!/^\d+$/.test(s)) {
    throw new Error(`expires_at_unix_sec must be an integer string, got ${JSON.stringify(intSecs)}`);
  }
  return `${s}.0`;
}

// Maps a TradeCollection slug to the deposit transaction template variant
// (kept for log breadcrumbs; the deposit template is universal — see cadence.ts).
function depositTemplateName(collection: TradeCollection): string {
  return `deposit_to_trade_${collection}.cdc`;
}

// Broadcast a hot-wallet-signed transaction and wait for it to seal. Throws on
// a sealed-with-error result (a sealed tx can still have reverted). Returns the
// sealed transaction status so callers can inspect events.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function submitAsHotWallet(cadence: string, args: any, verb: string): Promise<{ txId: string; sealed: any }> {
  configureFcl();
  const authz = buildHotWalletAuthz();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txId: string = await (fcl.mutate as any)({
    cadence,
    args,
    proposer: authz,
    payer: authz,
    authorizations: [authz],
    limit: 9999,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sealed: any = await (fcl.tx(txId) as any).onceSealed();
  if (sealed?.errorMessage) {
    throw new Error(`trade-escrow ${verb} tx ${txId} reverted: ${sealed.errorMessage}`);
  }
  return { txId, sealed };
}

export async function submitProposeTrade(args: ProposeTradeArgs): Promise<SubmittedTx> {
  const addr = ensureLive("propose");
  logCall("propose", args);
  // Validate the expiry eagerly (before broadcasting), not lazily inside the
  // args resolver — a malformed expiry should never reach the chain.
  const expiresAt = toUFix64(args.expires_at_unix_sec);
  const { txId, sealed } = await submitAsHotWallet(
    proposeTradeCadence(addr),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (arg: any) => [
      arg(args.partyA, t.Address),
      arg(args.partyB, t.Address),
      arg(args.partyA_nft_type, t.String),
      arg(args.partyB_nft_type, t.String),
      arg(args.partyA_expected_ids, t.Array(t.UInt64)),
      arg(args.partyB_expected_ids, t.Array(t.UInt64)),
      arg(expiresAt, t.UFix64),
    ],
    "propose"
  );
  // The assigned chain_trade_id rides on the TradeProposed event. The route
  // layer persists it via the event-listener backfill; we surface it in logs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposed = (sealed?.events ?? []).find((e: any) => typeof e?.type === "string" && e.type.endsWith("RPCTradeEscrow.TradeProposed"));
  if (proposed?.data?.tradeId != null) {
    console.log(`[trade-escrow] propose tx ${txId} => tradeId ${proposed.data.tradeId}`);
  }
  return { tx_id: txId, sealed: true };
}

export async function submitDepositToTrade(args: DepositToTradeArgs): Promise<SubmittedTx> {
  const addr = ensureLive("deposit");
  // Signed by the hot wallet acting as a SYNTHETIC depositor — testnet
  // smoke-testing only. Production deposits are signed by the user's own
  // wallet via lib/trade-escrow/sign-deposit.ts. Do not call from prod routes.
  const meta = COLLECTION_META[args.collection];
  const incoming = COLLECTION_META[args.incoming_collection];
  logCall("deposit", {
    ...args,
    template: depositTemplateName(args.collection),
    storage_path: meta.storage_path,
    incoming_public_path: incoming.public_path,
  });
  const { txId } = await submitAsHotWallet(
    depositToTradeCadence(addr, meta.storage_path, meta.public_path, incoming.public_path),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (arg: any) => [
      arg(args.chain_trade_id, t.UInt64),
      arg(args.nft_ids, t.Array(t.UInt64)),
    ],
    "deposit"
  );
  return { tx_id: txId, sealed: true };
}

export async function submitExecuteSwap(args: ExecuteSwapArgs): Promise<SubmittedTx> {
  const addr = ensureLive("execute");
  logCall("execute", args);
  const { txId } = await submitAsHotWallet(
    executeSwapCadence(addr),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (arg: any) => [arg(args.chain_trade_id, t.UInt64)],
    "execute"
  );
  return { tx_id: txId, sealed: true };
}

export async function submitCancelTrade(args: CancelTradeArgs): Promise<SubmittedTx> {
  const addr = ensureLive("cancel");
  // Hot-wallet server version is testnet smoke-testing only; production cancels
  // are signed by the cancelling party via lib/trade-escrow/sign-cancel.ts.
  logCall("cancel", args);
  const { txId } = await submitAsHotWallet(
    cancelTradeCadence(addr),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (arg: any) => [
      arg(args.chain_trade_id, t.UInt64),
      arg(args.reason, t.String),
    ],
    "cancel"
  );
  return { tx_id: txId, sealed: true };
}

export async function submitReclaimExpired(args: ReclaimExpiredArgs): Promise<SubmittedTx> {
  const addr = ensureLive("reclaim");
  logCall("reclaim", args);
  const { txId } = await submitAsHotWallet(
    reclaimExpiredCadence(addr),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (arg: any) => [arg(args.chain_trade_id, t.UInt64)],
    "reclaim"
  );
  return { tx_id: txId, sealed: true };
}
