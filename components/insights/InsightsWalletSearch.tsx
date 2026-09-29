// components/insights/InsightsWalletSearch.tsx
//
// Above-the-fold wallet-paste box on the /insights hub. Now a thin binding over
// the canonical components/WalletSearch — it used to be a FORK of the homepage
// box, and because the fork never called trackFunnelEvent, every paste on the
// highest-traffic public surface (insights_view 40/7d vs home_view 20/7d) was
// invisible in funnel_events. (2026-07-25: unforked + instrumented as
// surface="insights_hub".)
//
// Destination stays the deep public Top Collector Report rather than /share.
// Visual spec is unchanged: variant="inline" IS the 52px / r8 / max-560 box
// this file used to hand-roll.
//
// Signed in with a linked Flow wallet (2026-09-28): "Run your own report" sits
// under the box, so a signed-in reader is never asked to paste their own wallet.

import WalletSearch from "@/components/WalletSearch"
import OwnWalletLink from "@/components/insights/OwnWalletLink"

export default function InsightsWalletSearch() {
  return (
    <>
    <WalletSearch
      surface="insights_hub"
      variant="inline"
      destination="tc-report"
      placeholder="Run a report — Top Shot username or Flow wallet (0x…)"
      ariaLabel="Run a Top Collector Report for a Top Shot username or Flow wallet"
      submitLabel="Run →"
      pendingLabel="…"
      style={{ marginTop: 22 }}
    />
    <OwnWalletLink to="tc-report" label="Run your own report" />
    </>
  )
}
