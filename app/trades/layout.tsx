import type { Metadata } from "next";
import { BRAND_TITLE_TEMPLATE } from "@/lib/seo";
import GlobalSiteHeader from "@/components/GlobalSiteHeader";
import { PageContentAnchor } from "@/components/SkipToContent";

// /trades — user-to-user trade rooms (Trevor, 2026-10-31; All Day + Golazos 2026-11-02). Signed in only
// (proxy.ts sends anon to /login); never indexed.
export const metadata: Metadata = {
  // R31: a string title here would strip the brand from every descendant (the
  // public /trades/block pages rendered "<title>Trade Block</title>" until 11-06).
  title: { absolute: "Trades | Rip Packs City", template: BRAND_TITLE_TEMPLATE },
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
