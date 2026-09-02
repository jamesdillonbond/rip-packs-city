// app/early-access/page.tsx
//
// Thin server shell. The signup form is a controlled client form with its own
// validation, an on-blur on-chain nudge and a submit state machine, so the body
// lives in EarlyAccessClient.tsx — which the component coverage gate measures
// (`app/**/*Client.tsx`). A `page.tsx` matches NEITHER gate's include.

import EarlyAccessClient from "./EarlyAccessClient"
import SupportChatConnected from "@/components/SupportChatConnected"

export default function EarlyAccessPage() {
  return (
    <>
      <EarlyAccessClient />
      {/* Concierge, added 2026-09-02 with the /insights + home mounts: this is a
          public entry point a stranger lands on and it had no way to ask a
          question. No sub-layout here carries the launcher, so there is no
          double-mount. Revert: delete this line and the import. */}
      <SupportChatConnected />
    </>
  )
}
