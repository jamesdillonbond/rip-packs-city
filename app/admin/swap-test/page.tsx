// app/admin/swap-test/page.tsx
//
// Trevor-only: the two-signer swap test (docs/strategy/trading-revisit-2026-10-03.md §6).
// Server shell; the console is SwapTestClient. Token-gated per call against
// RPC_ADMIN_TOKEN (/api/admin/swap-test).

import { Suspense } from "react"
import SwapTestClient from "./SwapTestClient"

export default function SwapTestPage() {
  return (
    <Suspense fallback={null}>
      <SwapTestClient />
    </Suspense>
  )
}
