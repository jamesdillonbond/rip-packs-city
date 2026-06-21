import type { Metadata } from "next";
import { notFound } from "next/navigation";

export const metadata: Metadata = {
  title: "Rewards",
  description:
    "Earn status and Credits for using Rip Packs City — link a wallet, complete your profile, scout the market — and spend Credits on Pro time, cosmetics, raffles, and Moments.",
  robots: { index: false, follow: true },
};

export default function RewardsLayout({ children }: { children: React.ReactNode }) {
  // Hidden for launch - Rewards is dial-in (store unstocked, raffle pending legal review).
  // Remove this notFound() (or revert this commit) to re-enable.
  notFound();
  return children;
}
