import type { Metadata } from "next"
import PinnacleSniper from "@/components/pinnacle/PinnacleSniper"

export const metadata: Metadata = {
  title: "Disney Pinnacle — Pin Sniper | Rip Packs City",
  description: "Snipe the best deals on Disney Pinnacle pins. Browse listings by variant, edition type, and studio.",
}

export default function PinnaclePage() {
  return (
    <main
      style={{
        maxWidth: "var(--max-width)",
        margin: "0 auto",
        padding: "24px 16px 60px",
      }}
    >
      {/* Page header */}
      <div style={{ marginBottom: 24 }}>
        <h1
          className="rpc-heading"
          style={{
            fontSize: "var(--text-2xl)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <span style={{ fontSize: 28 }}>✨</span>
          Disney Pinnacle — Pin Sniper
        </h1>
        <p
          className="rpc-mono"
          style={{
            color: "var(--rpc-text-muted)",
            marginTop: 6,
          }}
        >
          Live listings from Flowty marketplace. Prices in USD.
        </p>
      </div>

      <PinnacleSniper />
    </main>
  )
}
