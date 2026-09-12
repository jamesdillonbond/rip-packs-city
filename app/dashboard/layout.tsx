import type { Metadata } from "next";
import MobileNav from "@/components/MobileNav";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your collector intelligence dashboard — saved wallets, trophy case, market pulse, and personalized deals.",
  robots: { index: false, follow: true },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // ⚠ WAS `return children`, and that is why Pack History had no bottom nav.
  // The bar is mounted ad hoc in eleven places rather than the root layout, and
  // of the six routes under /dashboard only two carried it (`page.tsx` and
  // `api-keys`). Measured 2026-09-12: /dashboard/packs — the surface Trevor
  // screenshotted — /dashboard/history, /dashboard/alerts and
  // /dashboard/notifications had no bottom nav at all.
  //
  // Mounting it HERE rather than in the root layout is deliberate: the root
  // would also put a bar on /login and every other surface that has never had
  // one, which is a bigger change than this fixes. The two child mounts were
  // removed in the same commit so nothing renders it twice.
  return (
    <>
      {children}
      <MobileNav />
    </>
  );
}
