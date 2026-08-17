// app/early-access/page.tsx
//
// Thin server shell. The signup form is a controlled client form with its own
// validation, an on-blur on-chain nudge and a submit state machine, so the body
// lives in EarlyAccessClient.tsx — which the component coverage gate measures
// (`app/**/*Client.tsx`). A `page.tsx` matches NEITHER gate's include.

import EarlyAccessClient from "./EarlyAccessClient"

export default function EarlyAccessPage() {
  return <EarlyAccessClient />
}
