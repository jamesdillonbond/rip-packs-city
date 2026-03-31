import "./globals.css"
import type { Metadata } from "next"
import { CartProvider } from "@/lib/cart/CartContext"
import { rootMetadata, organizationJsonLd } from "@/lib/seo"

export const metadata: Metadata = rootMetadata

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationJsonLd) }}
        />
        <CartProvider>
          {children}
        </CartProvider>
      </body>
    </html>
  )
}
