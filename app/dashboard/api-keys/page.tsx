// app/dashboard/api-keys/page.tsx
//
// Server shell. The surface lives in ApiKeysClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// This page was already CLEAN on the failed-read-vs-empty sweep (it consults
// `loadError` before its empty state), so this is coverage, not a fix. Recorded here
// so nobody re-sweeps it.

import ApiKeysClient from "./ApiKeysClient";

export default function ApiKeysPage() {
  return <ApiKeysClient />;
}
