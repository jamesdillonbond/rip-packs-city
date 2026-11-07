// app/dashboard/api-keys/page.tsx
//
// Server shell. The surface lives in ApiKeysClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// This page was already CLEAN on the failed-read-vs-empty sweep (it consults
// `loadError` before its empty state), so this is coverage, not a fix. Recorded here
// so nobody re-sweeps it.

import type { Metadata } from "next";
import ApiKeysClient from "./ApiKeysClient";

// R31: the dashboard layout's template needs a STRING title here or the tab
// reads the generic "Dashboard" (walked 2026-11-06).
export const metadata: Metadata = { title: "API keys", robots: { index: false, follow: false } };

export default function ApiKeysPage() {
  return <ApiKeysClient />;
}
