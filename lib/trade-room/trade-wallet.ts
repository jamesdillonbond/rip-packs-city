// lib/trade-room/trade-wallet.ts
//
// A trade-room user's Flow Wallet on /trades/<code> (Trevor, 2026-10-31: "continue
// building out our trade features" → user-to-user trade room; the product's third
// Flow Wallet exception after the giveaway admin and claim flows, pinned by
// __tests__/no-client-wallet-connect.test.ts). Two uses, nothing else:
//   * CONNECT WITH PROOF: at connect the wallet signs FCL's account proof (a
//     sign-in, no fee) so the server can verify the user controls it before it
//     records that wallet as the side's signer (lib/giveaways/claim-proof.ts);
//   * SIGN THE SWAP: once both sides accepted, the initiator's wallet submits the
//     two-authorizer swap and the other side's wallet co-signs it through the relay —
//     the SAME code as the admin swap test (lib/swap-test/swap-wallet.ts), so the
//     wallets sign exactly the transaction that test proves.
// Only app/trades/[code]/TradeRoomClient.tsx imports it. RPC never holds a key.

export {
  connectFlowWalletWithProof as connectTradeWalletWithProof,
  connectFlowWallet as connectTradeWallet,
  disconnectFlowWallet as disconnectTradeWallet,
  type AccountProof,
} from "@/lib/giveaways/flow-wallet-connect"

export { coSign, sendMultiSwap, sendSwap, SealUnconfirmedError, TRADE_ROOM_CADENCES } from "@/lib/swap-test/swap-wallet"
