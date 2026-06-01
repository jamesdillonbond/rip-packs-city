// NEXT_STEPS — Backend FCL submitter for RPCTradeEscrow.
//
// Today this module is a STUB. Every function logs the intended on-chain
// call and returns a fake `0xstub_<verb>_<random>` tx id so the rest of the
// trade-chain pipeline (API routes, DB writes, UI state machine) can be
// exercised end-to-end before the contract is deployed.
//
// When the contract is live:
//   - read RPC_TRADE_ESCROW_ADDRESS from env at module load
//   - replace each `// TODO …` block with an `fcl.send([fcl.transaction(...),
//     fcl.proposer, fcl.payer, fcl.authorizations([...]), fcl.args([...])])`
//     call signed by the RPC hot wallet (0x3aa11c84d776838f — see CLAUDE.md
//     "Hot wallet & secrets")
//   - the Cadence templates to inline are in RPCTradeEscrow_DEPLOYMENT.md:
//       submitProposeTrade        → §3a propose_trade.cdc
//       submitDepositToTrade      → §3b deposit_to_trade_<collection>.cdc
//       submitExecuteSwap         → §3c execute_swap.cdc
//       submitCancelTrade         → §3d cancel_trade.cdc
//       submitReclaimExpired      → §3e reclaim_expired.cdc
//   - encode UInt64 args as `String(v)` per RPC_DESIGN_SYSTEM.md §8
//
// Signatures here are FINAL — the API routes call these as-written.

import type {
  CancelTradeArgs,
  DepositToTradeArgs,
  ExecuteSwapArgs,
  ProposeTradeArgs,
  ReclaimExpiredArgs,
  SubmittedTx,
  TradeCollection,
} from "./types";
import { COLLECTION_META } from "./types";

function stubTxId(verb: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `0xstub_${verb}_${rand}`;
}

function contractAddress(): string {
  // Resolved at call time so unit tests can override via env. Stub mode does
  // not require this to be set; live mode does.
  return process.env.RPC_TRADE_ESCROW_ADDRESS ?? "<unset>";
}

// Trade escrow is on-chain swapping infrastructure that is NOT yet deployed —
// the RPCTradeEscrow contract has no mainnet address. Until it does, every
// submitter below would return a fabricated `0xstub_` tx id, implying an
// on-chain swap that never happened. This guard makes them hard-fail loudly
// instead. Same shelved-until-real posture as Cart (CLAUDE.md Open #1).
function ensureLive(verb: string): void {
  const addr = process.env.RPC_TRADE_ESCROW_ADDRESS;
  if (!addr || addr === "<unset>") {
    throw new Error(
      `Trade escrow unavailable: RPCTradeEscrow contract not deployed (${verb}). Set RPC_TRADE_ESCROW_ADDRESS to enable.`
    );
  }
}

function logCall(verb: string, payload: unknown) {
  console.log(
    `[trade-escrow:stub] ${verb} contract=${contractAddress()} payload=${JSON.stringify(payload)}`
  );
}

// Maps a TradeCollection slug to the deposit transaction template variant
// (one Cadence file per collection per §3b). Used only for stub logging
// today; will be used to select the inlined Cadence template once wired.
function depositTemplateName(collection: TradeCollection): string {
  return `deposit_to_trade_${collection}.cdc`;
}

export async function submitProposeTrade(args: ProposeTradeArgs): Promise<SubmittedTx> {
  ensureLive("propose");
  // TODO — replace with the §3a propose_trade.cdc template. Signed by the
  // RPC hot wallet acting as proposer. Returns the assigned chain_trade_id
  // via a TradeProposed event; the route layer must parse the event from the
  // sealed transaction to populate trade_chain_state.chain_trade_id.
  logCall("propose", args);
  return { tx_id: stubTxId("propose"), sealed: false };
}

export async function submitDepositToTrade(args: DepositToTradeArgs): Promise<SubmittedTx> {
  ensureLive("deposit");
  // TODO — replace with the per-collection §3b deposit_to_trade_<col>.cdc
  // template. Signed by the depositor (NOT the hot wallet) — so in
  // production this submitter is only invoked by the CLIENT-side helper at
  // lib/trade-escrow/sign-deposit.ts. The server-side path below exists for
  // smoke-testing the wiring with the hot wallet acting as a synthetic
  // depositor against testnet. Do not call from production server routes.
  const meta = COLLECTION_META[args.collection];
  const incoming = COLLECTION_META[args.incoming_collection];
  logCall("deposit", {
    ...args,
    template: depositTemplateName(args.collection),
    storage_path: meta.storage_path,
    incoming_public_path: incoming.public_path,
  });
  return { tx_id: stubTxId("deposit"), sealed: false };
}

export async function submitExecuteSwap(args: ExecuteSwapArgs): Promise<SubmittedTx> {
  ensureLive("execute");
  // TODO — replace with the §3c execute_swap.cdc template. Signed by the
  // RPC hot wallet (anyone can call, but backend pays so users don't).
  logCall("execute", args);
  return { tx_id: stubTxId("execute"), sealed: false };
}

export async function submitCancelTrade(args: CancelTradeArgs): Promise<SubmittedTx> {
  ensureLive("cancel");
  // TODO — replace with the §3d cancel_trade.cdc template. Signed by the
  // cancelling party. In a backend-relayed flow this submitter would be
  // called by the client wallet; for now the stub lets the route layer
  // pretend a cancellation was filed.
  logCall("cancel", args);
  return { tx_id: stubTxId("cancel"), sealed: false };
}

export async function submitReclaimExpired(args: ReclaimExpiredArgs): Promise<SubmittedTx> {
  ensureLive("reclaim");
  // TODO — replace with the §3e reclaim_expired.cdc template. Signed by
  // the RPC hot wallet (janitor role, anyone is permitted on-chain).
  logCall("reclaim", args);
  return { tx_id: stubTxId("reclaim"), sealed: false };
}
