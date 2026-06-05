import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rewards",
  description:
    "Earn status and Credits for using Rip Packs City — link a wallet, complete your profile, scout the market — and spend Credits on Pro time, cosmetics, raffles, and Moments.",
  robots: { index: false, follow: true },
};

export default function RewardsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
