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
