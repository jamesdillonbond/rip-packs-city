import "./globals.css"
import type { Metadata } from "next"
import { SpeedInsights } from "@vercel/speed-insights/next"
import { Analytics } from "@vercel/analytics/next"
import { CartProvider } from "@/lib/cart/CartContext"
import WarmupProvider from "@/lib/warmup/WarmupContext"
import { rootMetadata, organizationJsonLd } from "@/lib/seo"
import WalletPreloader from "@/components/WalletPreloader"
import OnboardingModal from "@/components/OnboardingModal"
import ConsoleGreeting from "@/components/visual/ConsoleGreeting"
import TelemetryPageView from "@/components/TelemetryPageView"
import RefCapture from "@/components/RefCapture"

export const metadata: Metadata = rootMetadata

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        {/* Pre-paint theme boot — applies the opt-in LIGHT theme before first
            paint so there is no flash. DARK is the default: an unset (or any
            non-'light') value leaves no attribute, rendering dark exactly as
            before. OS prefers-color-scheme is intentionally ignored.

            UN-GATED (2026-06-10): light mode is live for everyone. The toggle
            persists 'rpc_theme' ('light' | 'dark'); a 'light' value is honored
            directly. ?theme=light / ?theme=dark stays a harmless deep-link that
            just writes the same preference. The old 'rpc_theme_preview' gate is
            retired. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "try{var q=new URLSearchParams(location.search).get('theme');if(q==='light'){localStorage.setItem('rpc_theme','light')}else if(q==='dark'){localStorage.setItem('rpc_theme','dark')}localStorage.removeItem('rpc_theme_preview');if(localStorage.getItem('rpc_theme')==='light'){document.documentElement.dataset.theme='light'}}catch(e){}",
          }}
        />
        {/* brand-exception: HTML meta theme-color attribute can't resolve a CSS var */}
        <meta name="theme-color" content="#E03A2F" />
        <link rel="icon" href="/rip-packs-city-logo.png" />
        <link rel="apple-touch-icon" href="/rip-packs-city-logo.png" />
      </head>
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <ConsoleGreeting />
        <TelemetryPageView />
        <RefCapture />
        <WarmupProvider>
          <CartProvider>
            <WalletPreloader />
            <OnboardingModal />
            {children}
          </CartProvider>
        </WarmupProvider>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  )
}
