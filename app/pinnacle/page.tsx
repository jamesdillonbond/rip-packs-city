import type { Metadata } from "next"
import PinnacleSniper from "@/components/pinnacle/PinnacleSniper"

export const metadata: Metadata = {
  title: "Disney Pinnacle — Pin Sniper | RipPacks.city",
  description:
    "Snipe Disney Pinnacle digital pin deals on Flow blockchain. Filter by variant, edition type, studio, and more.",
}

export default function PinnaclePage() {
  return (
    <div
      className="min-h-screen"
      style={{
        background: "linear-gradient(180deg, #0a0e1a 0%, #0d1117 50%, #080b12 100%)",
      }}
    >
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-3xl">📌</span>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              Disney Pinnacle
              <span className="ml-2 text-amber-400">— Pin Sniper</span>
            </h1>
          </div>
          <p className="text-sm text-slate-400">
            Browse and filter live Pinnacle pin listings from Flowty.
            Prices in USD via DapperUtilityCoin.
          </p>
        </div>

        {/* Sniper feed */}
        <PinnacleSniper />
      </div>
    </div>
  )
}
