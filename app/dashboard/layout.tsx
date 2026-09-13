import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your collector intelligence dashboard — saved wallets, trophy case, market pulse, and personalized deals.",
  robots: { index: false, follow: true },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // ⚠ This was `return children` while the bottom nav was mounted ad hoc, and
  // that is why Pack History had none: of the six routes under /dashboard only
  // `page.tsx` and `api-keys` mounted the bar themselves, so /dashboard/packs —
  // the surface Trevor screenshotted — /dashboard/history, /dashboard/alerts and
  // /dashboard/notifications had no bottom nav at all (measured 2026-09-12).
  // The bar now lives in the ROOT layout, mounted exactly once, so there is
  // nothing to add here. Do not re-add it: two fixed bottom bars stack invisibly.
  return children;
}
