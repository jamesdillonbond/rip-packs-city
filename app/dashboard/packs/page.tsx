import type { Metadata } from "next";
// app/dashboard/packs/page.tsx
//
// Server shell. The dashboard lives in PackHistoryClient so the COMPONENT coverage gate
// measures it — `app/**/page.tsx` matches neither gate's include.
//
// Already CLEAN on the failed-read sweep (`walletsFailed` is explicitly distinct from an
// empty wallet list, and both summary and history carry their own error state), so this is
// coverage, not a fix.

import PackHistoryClient from "./PackHistoryClient";

// 2026-11-06: the layout template gives "Pack history | Rip Packs City"; without this the tab read "Dashboard".
export const metadata: Metadata = { title: "Pack history", robots: { index: false, follow: false } };

export default function PackHistoryPage() {
  return <PackHistoryClient />;
}
