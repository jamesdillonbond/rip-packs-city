// app/auth/confirm/page.tsx
//
// Thin server shell. The whole body is client-only by necessity — browsers do
// not transmit URL fragments to the server, and the magic-link tokens arrive in
// the hash — so it lives in AuthConfirmClient.tsx, which the component coverage
// gate measures (`app/**/*Client.tsx`). A `page.tsx` matches NEITHER gate's
// include, which is the entire reason for the split.

import AuthConfirmClient from "./AuthConfirmClient"

export default function ConfirmPage() {
  return <AuthConfirmClient />
}
