import Link from "next/link"
import { CartButton } from "@/components/cart/CartButton"
import { ProBadge } from "@/components/auth/ProBadge"
import SignOutButton from "@/components/auth/SignOutButton"
import SupportChatConnected from "@/components/SupportChatConnected"
import SiteFooter from "@/components/SiteFooter"
import MobileNav from "@/components/MobileNav"
import RpcLogo from "@/components/RpcLogo"
import TopNav from "@/components/TopNav"
import AnalyticsSidebar from "@/components/analytics/AnalyticsSidebar"
import AnalyticsBreadcrumb from "@/components/analytics/AnalyticsBreadcrumb"

export default function AnalyticsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <SiteHeader />
      <div className="mx-auto w-full max-w-[1440px] px-4 lg:px-6 py-6 flex gap-8">
        <AnalyticsSidebar />
        <main className="flex-1 min-w-0">
          <AnalyticsBreadcrumb />
          {children}
        </main>
      </div>
      <SiteFooter />
      <SupportChatConnected />
      <MobileNav />
    </div>
  )
}

function SiteHeader() {
  return (
    <header
      className="sticky top-0 z-50 border-b border-slate-800/60 bg-slate-950/95 backdrop-blur"
    >
      <div className="mx-auto flex h-14 max-w-[1440px] items-center gap-4 px-5">
        <Link href="/" className="flex flex-shrink-0 items-center gap-2.5 no-underline">
          <RpcLogo size={32} />
          <span
            className="hidden sm:block text-[7px] tracking-widest text-red-500/60"
            style={{ fontFamily: "'Share Tech Mono', monospace", letterSpacing: "0.2em" }}
          >
            @RIPPACKSCITY
          </span>
        </Link>
        <TopNav />
        <div className="flex-1" />
        <ProBadge />
        <CartButton />
        <SignOutButton />
      </div>
    </header>
  )
}
