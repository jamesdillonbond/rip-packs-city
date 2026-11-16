import type { Metadata } from "next";
import { BRAND_TITLE_TEMPLATE } from "@/lib/seo";

// /trades/compare — "what could two collectors trade?" (2026-11-16). Public like the Trade Block:
// it reads by username only (no wallet connect, no sign-in) and shows what Top Shot profiles
// already show. The parent /trades layout is signed-in and noindex; this re-opens indexing for
// the bare page. Starting a trade room from it still needs an account (proxy + route).
export const metadata: Metadata = {
  title: { absolute: "Compare Collections for Trades | Rip Packs City", template: BRAND_TITLE_TEMPLATE },
  description:
    "Enter two NBA Top Shot usernames and see the duplicates each collector could trade the other — checked on chain for locks and listings, priced with Rip Packs City's FMV.",
  robots: { index: true, follow: true },
  alternates: { canonical: "/trades/compare" },
};

export default function TradeCompareLayout({ children }: { children: React.ReactNode }) {
  return children;
}
