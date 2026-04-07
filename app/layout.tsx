import "./globals.css"
import type { Metadata } from "next"
import { CartProvider } from "@/lib/cart/CartContext"
import { rootMetadata, organizationJsonLd } from "@/lib/seo"
import WalletPreloader from "@/components/WalletPreloader"

export const metadata: Metadata = rootMetadata

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta name="theme-color" content="#f97316" />
        <link rel="apple-touch-icon" href="/rip-packs-city-logo.png" />
      </head>
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <CartProvider>
          <WalletPreloader />
          {children}
        </CartProvider>
      </body>
    </html>
  )
}
