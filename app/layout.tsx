import "./globals.css"
import type { Metadata } from "next"
import { Barlow_Condensed, Share_Tech_Mono } from "next/font/google"
import { SpeedInsights } from "@vercel/speed-insights/next"
import { Analytics } from "@vercel/analytics/next"
import WarmupProvider from "@/lib/warmup/WarmupContext"
import { rootMetadata, organizationJsonLd } from "@/lib/seo"
import WalletPreloader from "@/components/WalletPreloader"
import ConsoleGreeting from "@/components/visual/ConsoleGreeting"
import TelemetryPageView from "@/components/TelemetryPageView"
import RefCapture from "@/components/RefCapture"
import DeadImageGuard from "@/components/media/DeadImageGuard"
import ClientErrorBeacon from "@/components/telemetry/ClientErrorBeacon"

export const metadata: Metadata = rootMetadata

// Brand fonts, self-hosted by next/font (no external request, no CSP dependency,
// no layout shift). The `variable` CSS vars are consumed by --font-display /
// --font-body / --font-mono in app/rpc-tokens.css. Barlow Condensed is a static
// (non-variable) family, so the used weights must be enumerated — this is the
// superset across every surface (matches the retired per-page @import list).
const barlowCondensed = Barlow_Condensed({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
  variable: "--font-barlow",
  display: "swap",
})
const shareTechMono = Share_Tech_Mono({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-share-tech",
  display: "swap",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={`dark ${barlowCondensed.variable} ${shareTechMono.variable}`}>
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
        {/* Warm the connection to the moment-media + IPFS art hosts so
            thumbnails on the collection / moment / edition surfaces paint sooner. */}
        <link rel="preconnect" href="https://assets.nbatopshot.com" crossOrigin="" />
        <link rel="preconnect" href="https://ipfs.dapperlabs.com" crossOrigin="" />
        <link rel="dns-prefetch" href="https://assets.nbatopshot.com" />
        <link rel="dns-prefetch" href="https://ipfs.dapperlabs.com" />
      </head>
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <ConsoleGreeting />
        <TelemetryPageView />
        <RefCapture />
        <DeadImageGuard />
        <ClientErrorBeacon />
        <WarmupProvider>
            <WalletPreloader />
            {children}
        </WarmupProvider>
        <SpeedInsights />
        <Analytics />
      </body>
    </html>
  )
}
