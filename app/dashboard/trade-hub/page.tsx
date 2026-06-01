// app/dashboard/trade-hub/page.tsx
//
// Server gate for the Trade Hub. On-chain trade escrow (RPCTradeEscrow) is
// not yet deployed, so the whole surface is shelved — same posture as Cart
// (CLAUDE.md Open #1). While RPC_TRADE_ESCROW_ADDRESS is unset the route 404s
// so users can never reach a panel that would imply a swap the contract can't
// actually execute. The CRUD UI lives in TradeHubClient and re-appears the
// moment the env var is set (alongside wiring the real fcl submitters).
//
// This MUST stay a server component: RPC_TRADE_ESCROW_ADDRESS is a non-public
// env var and is only readable server-side.

import { notFound } from "next/navigation"
import TradeHubClient from "./TradeHubClient"

export default function TradeHubPage() {
  if (!process.env.RPC_TRADE_ESCROW_ADDRESS) notFound()
  return <TradeHubClient />
}
