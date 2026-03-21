import "./globals.css"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Rip Packs City",
  description: "Wallet intelligence for digital collectibles",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-black text-zinc-100 antialiased">
        {children}
      </body>
    </html>
  )
}