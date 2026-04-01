import type { Metadata } from "next"

export async function generateMetadata(): Promise<Metadata> {
  const title = "Pack EV Calculator — NBA Top Shot Secondary Market"
  const description =
    "Calculate expected value for every NBA Top Shot pack on the secondary market. Real-time FMV, pull rates, and tier breakdowns powered by RPC."
  return {
    title,
    description,
    openGraph: {
      title: title + " | Rip Packs City",
      description,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  }
}

export default function PacksLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <>{children}</>
}
