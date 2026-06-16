import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Alerts",
  description:
    "Set up deal & FMV alerts on Rip Packs City — match listings under FMV by player, set, team, tier, price and discount, delivered to email, Telegram, or Discord.",
  robots: { index: false, follow: true },
};

export default function AlertsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
