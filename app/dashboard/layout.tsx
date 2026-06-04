import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dashboard",
  description:
    "Your collector intelligence dashboard — saved wallets, trophy case, market pulse, and personalized deals.",
  robots: { index: false, follow: true },
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return children;
}
