"use client"

import PinnacleSniper from "@/components/pinnacle/PinnacleSniper"

export default function PinnaclePage() {
  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: "24px 16px" }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1
          style={{
            color: "#f1f5f9",
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.02em",
          }}
        >
          Disney Pinnacle{" "}
          <span style={{ color: "#a78bfa", fontWeight: 400 }}>
            — Pin Sniper
          </span>
        </h1>
        <p style={{ color: "#64748b", fontSize: 13, marginTop: 4 }}>
          Browse live Flowty listings for Disney, Pixar, Star Wars &amp; more
        </p>
      </div>

      <PinnacleSniper />
    </div>
  )
}
