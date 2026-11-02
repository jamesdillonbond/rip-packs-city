import type { Metadata } from "next";
import GlobalSiteHeader from "@/components/GlobalSiteHeader";
import { PageContentAnchor } from "@/components/SkipToContent";

// /trades — user-to-user trade rooms (Trevor, 2026-10-31; All Day + Golazos 2026-11-02). Signed in only
// (proxy.ts sends anon to /login); never indexed.
export const metadata: Metadata = {
  title: "Trades",
  description:
    "Trade NBA Top Shot, NFL All Day, LaLiga Golazos and UFC Strike Moments collector to collector on Rip Packs City — both wallets sign one transaction, so either every Moment moves or nothing does. No custody, no fee.",
  robots: { index: false, follow: false },
};

export default function TradesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <GlobalSiteHeader />
      <PageContentAnchor />
      {children}
    </>
  );
}
