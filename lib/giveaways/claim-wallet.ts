// lib/giveaways/claim-wallet.ts
//
// A giveaway WINNER's wallet connection on /giveaways/<slug> (Trevor, 2026-10-03:
// "Let's plan on using Flow Wallet to claim instead of Dapper"). It learns which
// Flow Wallet the winner controls so they can choose where their pack goes (that
// wallet, or a Dapper account linked to it, verified on chain by the server).
// It never signs or sends a transaction; at connect the wallet signs FCL's
// account proof (a sign-in) so the server can verify the wallet is theirs
// (lib/giveaways/claim-proof.ts). Only app/giveaways/[slug]/GiveawayClient.tsx
// imports it (pinned by __tests__/no-client-wallet-connect.test.ts).

export {
  connectFlowWalletWithProof as connectClaimWallet,
  disconnectFlowWallet as disconnectClaimWallet,
  type AccountProof,
} from "@/lib/giveaways/flow-wallet-connect"
