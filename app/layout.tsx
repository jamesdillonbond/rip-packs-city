import "./globals.css"
import type { Metadata } from "next"
import { CartProvider } from "@/lib/cart/CartContext"
import { rootMetadata, organizationJsonLd } from "@/lib/seo"
import ServiceWorkerRegistrar from "@/components/ServiceWorkerRegistrar"

export const metadata: Metadata = rootMetadata

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#f97316" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <link rel="apple-touch-icon" href="/rip-packs-city-logo.png" />
      </head>
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <CartProvider>
          {children}
        </CartProvider>
        <ServiceWorkerRegistrar />
      </body>
    </html>
  )
}
