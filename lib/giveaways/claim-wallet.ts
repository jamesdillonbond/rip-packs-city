// lib/giveaways/claim-wallet.ts
//
// A giveaway WINNER's wallet connection on /giveaways/<slug> (Trevor, 2026-10-03:
// "Let's plan on using Flow Wallet to claim instead of Dapper"). CONNECT ONLY: it
// learns which Flow Wallet the winner controls so they can choose where their pack
// goes (that wallet, or a Dapper account linked to it, verified on chain by the
// server). It never signs or sends a transaction. Only
// app/giveaways/[slug]/GiveawayClient.tsx imports it (pinned by
// __tests__/no-client-wallet-connect.test.ts).

export { connectFlowWallet as connectClaimWallet, disconnectFlowWallet as disconnectClaimWallet } from "@/lib/giveaways/flow-wallet-connect"
