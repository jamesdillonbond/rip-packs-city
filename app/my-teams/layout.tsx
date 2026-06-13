import Link from "next/link"
import { ProBadge } from "@/components/auth/ProBadge"
import SignOutButton from "@/components/auth/SignOutButton"
import SupportChatConnected from "@/components/SupportChatConnected"
import SiteFooter from "@/components/SiteFooter"
import MobileNav from "@/components/MobileNav"
import RpcLogo from "@/components/RpcLogo"
import TopNav from "@/components/TopNav"
import ThemeToggle from "@/components/ThemeToggle"

// Top-level authed route (like /analytics). The page itself enforces auth and
// proxy.ts also gates it (not in the public allowlist); this layout just
// provides the standard site chrome.
export default function MyTeamsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="sticky top-0 z-50 border-b border-zinc-800/60 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-5">
          <Link href="/" className="flex flex-shrink-0 items-center gap-2.5 no-underline">
            <RpcLogo size={32} />
            <span
              className="hidden sm:block text-[7px] tracking-widest text-red-500/60"
              style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.2em" }}
            >
              @RIPPACKSCITY
            </span>
          </Link>
          <TopNav />
          <div className="flex-1" />
          <ThemeToggle />
          <ProBadge />
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto w-full max-w-[1100px] px-4 lg:px-6 py-6">{children}</div>
      <SiteFooter />
      <SupportChatConnected />
      <MobileNav />
    </div>
  )
}
