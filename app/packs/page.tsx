"use client"

import { useState } from "react"

type EditionEV = {
  editionId: string
  playerName: string
  setName: string
  tier: string
  parallelName: string | null
  probability: number
  averageSalePrice: number
  lowAsk: number
  editionEV: number
  remaining: number
  count: number
  circulationCount: number
  hiddenInPacks: number
  forSaleByCollectors: number
  locked: number
  burned: number
  lockedPct: number
  depletionPct: number
  hasSerialOne: boolean
  hasLastMint: boolean
  hasJerseyMatch: boolean
  serialPremiumLabel: string | null
}

type TierEVSummary = {
  editionCount: number
  totalEV: number
  avgEditionEV: number
  remainingMoments: number
}

type SupplySnapshot = {
  totalUnopened: number
  totalPackCount: number
  depletionPct: number
  remainingByTier: Record<string, number>
  originalByTier: Record<string, number>
  forSale: boolean
  isSoldOut: boolean
}

type PackEVResponse = {
  packListingId: string
  packPrice: number
  packEV: number
  grossEV: number
  isPositiveEV: boolean
  evVerdict: string
  topPulls: EditionEV[]
  serialPremiumAlerts: string[]
  tierBreakdown: Record<string, TierEVSummary>
  supplySnapshot: SupplySnapshot
  editionCount: number
  methodology: string
  error?: string
}

function fmt(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-"
  return "$" + value.toFixed(2)
}

function tierBadge(tier: string): string {
  if (tier === "ultimate") return "bg-yellow-950 text-yellow-300 border-yellow-800"
  if (tier === "legendary") return "bg-purple-950 text-purple-300 border-purple-800"
  if (tier === "rare") return "bg-blue-950 text-blue-300 border-blue-800"
  if (tier === "fandom") return "bg-pink-950 text-pink-300 border-pink-800"
  return "bg-zinc-900 text-zinc-300 border-zinc-700"
}

function tierText(tier: string): string {
  if (tier === "ultimate") return "text-yellow-300"
  if (tier === "legendary") return "text-purple-300"
  if (tier === "rare") return "text-blue-300"
  if (tier === "fandom") return "text-pink-300"
  return "text-zinc-300"
}

function evColor(isPositive: boolean): string {
  return isPositive ? "text-green-400" : "text-red-400"
}

export default function PacksPage() {
  const [packListingId, setPackListingId] = useState("")
  const [packPrice, setPackPrice] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [result, setResult] = useState<PackEVResponse | null>(null)
  const [showAllPulls, setShowAllPulls] = useState(false)
  const [showAllAlerts, setShowAllAlerts] = useState(false)

  // Trade Ticket mode
  const [ttMode, setTtMode] = useState(false)
  const [ttCount, setTtCount] = useState("")
  const [ttFloor, setTtFloor] = useState("")

  // Derived TT cost and EV
  const ttCost = ttMode && ttCount && ttFloor
    ? parseFloat(ttCount) * parseFloat(ttFloor)
    : null
  const ttPackEV = result !== null && ttCost !== null
    ? Math.round((result.grossEV - ttCost) * 100) / 100
    : null
  const ttIsPositive = ttPackEV !== null && ttPackEV > 0

  function buildVerdict(): string {
    if (ttMode) {
      if (ttPackEV === null) return "Enter TT count and floor price to get verdict"
      const abs = Math.abs(ttPackEV).toFixed(2)
      if (ttIsPositive) return "+EV by $" + abs + " — burning TTs beats buying direct"
      return "-EV by $" + abs + " — cheaper to buy moments directly"
    }
    if (!result) return ""
    if (result.packPrice === 0) return "Enter a pack price to get the EV verdict"
    const abs = Math.abs(result.packEV).toFixed(2)
    if (result.isPositiveEV) return "+EV by $" + abs + " — opening beats buying direct"
    return "-EV by $" + abs + " — cheaper to buy moments directly"
  }

  function displayPackEV(): number | null {
    if (ttMode && ttPackEV !== null) return ttPackEV
    if (result !== null) return result.packEV
    return null
  }

  function displayIsPositive(): boolean {
    if (ttMode && ttPackEV !== null) return ttIsPositive
    if (result !== null) return result.isPositiveEV
    return false
  }

  function displayPackCost(): string {
    if (ttMode) {
      if (ttCost !== null) return fmt(ttCost)
      return "—"
    }
    if (result !== null && result.packPrice > 0) return fmt(result.packPrice)
    return "—"
  }

  function displayPackCostLabel(): string {
    if (ttMode && ttCost !== null && ttCount && ttFloor) {
      return ttCount + " TTs x " + fmt(parseFloat(ttFloor)) + " floor"
    }
    if (result !== null && result.packPrice > 0) return (result.editionCount) + " editions analyzed"
    return "Enter price to get EV verdict"
  }

  async function handleAnalyze() {
    const id = packListingId.trim()
    if (!id) return
    const uuidMatch = id.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    const resolvedId = uuidMatch ? uuidMatch[0] : id

    setLoading(true)
    setError("")
    setResult(null)
    setShowAllPulls(false)
    setShowAllAlerts(false)

    try {
      const response = await fetch("/api/pack-ev", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          packListingId: resolvedId,
          packPrice: !ttMode && packPrice ? parseFloat(packPrice) : 0,
        }),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error || "Pack EV analysis failed")
      setResult(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
    } finally {
      setLoading(false)
    }
  }

  const displayedPulls = result
    ? showAllPulls ? result.topPulls : result.topPulls.slice(0, 5)
    : []

  const displayedAlerts = result
    ? showAllAlerts ? result.serialPremiumAlerts : result.serialPremiumAlerts.slice(0, 8)
    : []

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <div className="mx-auto max-w-[1400px] px-3 py-4 md:px-6">

        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-4">
          <img
            src="/rip-packs-city-logo.png"
            alt="Rip Packs City"
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 9999 }}
          />
          <div>
            <h1 className="text-xl font-black tracking-wide text-white md:text-2xl">RIP PACKS CITY</h1>
            <p className="text-xs text-zinc-400 md:text-sm">Pack EV Calculator</p>
          </div>
          <div className="ml-auto flex gap-2">
            <a href="/wallet" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Wallet</a>
            <a href="/badges" className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-900">Badges</a>
          </div>
        </div>

        <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-sm font-semibold text-zinc-300">Analyze a Pack Drop</div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setTtMode(false)}
                className={"rounded-lg px-3 py-1 text-xs font-semibold transition " + (!ttMode ? "bg-red-600 text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}
              >
                Cash Price
              </button>
              <button
                onClick={() => setTtMode(true)}
                className={"rounded-lg px-3 py-1 text-xs font-semibold transition " + (ttMode ? "bg-red-600 text-white" : "border border-zinc-700 text-zinc-400 hover:bg-zinc-900")}
              >
                Trade Tickets
              </button>
            </div>
          </div>

          <div className="flex flex-wrap gap-3">
            <input
              value={packListingId}
              onChange={(e) => setPackListingId(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !loading && packListingId.trim()) handleAnalyze() }}
              placeholder="Pack listing ID or full URL"
              className="min-w-[320px] flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-red-600"
            />
            {!ttMode && (
              <input
                value={packPrice}
                onChange={(e) => setPackPrice(e.target.value)}
                placeholder="Pack price ($)"
                type="number"
                min="0"
                step="any"
                className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-red-600"
              />
            )}
            {ttMode && (
              <>
                <input
                  value={ttCount}
                  onChange={(e) => setTtCount(e.target.value)}
                  placeholder="# of TTs"
                  type="number"
                  min="1"
                  step="1"
                  className="w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-red-600"
                />
                <input
                  value={ttFloor}
                  onChange={(e) => setTtFloor(e.target.value)}
                  placeholder="TT floor ($)"
                  type="number"
                  min="0"
                  step="any"
                  className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-white outline-none placeholder:text-zinc-500 focus:border-red-600"
                />
              </>
            )}
            <button
              onClick={handleAnalyze}
              disabled={loading || !packListingId.trim()}
              className="rounded-lg bg-red-600 px-5 py-2 font-semibold text-white transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? "Analyzing..." : "Analyze"}
            </button>
          </div>

          <p className="mt-2 text-xs text-zinc-500">
            {ttMode
              ? "Trade Ticket cost = # of TTs x cheapest burnable moment floor (across all marketplaces)."
              : "Paste the full pack URL or just the UUID. Pack price is optional."}
          </p>

          {ttMode && ttCost !== null && (
            <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm">
              <span className="text-zinc-400">Effective pack cost: </span>
              <span className="font-bold text-white">{fmt(ttCost)}</span>
              <span className="ml-2 text-zinc-500">{"(" + ttCount + " TTs x " + fmt(parseFloat(ttFloor)) + " floor)"}</span>
            </div>
          )}
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800 bg-red-950 p-3 text-red-300">{error}</div>
        )}

        {result !== null && (
          <div>
            <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                  {ttMode ? "TT Pack EV" : "Pack EV"}
                </div>
                <div className={"text-2xl font-black " + evColor(displayIsPositive())}>{fmt(displayPackEV())}</div>
                <div className={"mt-1 text-xs " + evColor(displayIsPositive())}>{buildVerdict()}</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Gross EV</div>
                <div className="text-2xl font-black text-white">{fmt(result.grossEV)}</div>
                <div className="mt-1 text-xs text-zinc-500">Before subtracting pack cost</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">
                  {ttMode ? "TT Cost" : "Pack Price"}
                </div>
                <div className="text-2xl font-black text-white">{displayPackCost()}</div>
                <div className="mt-1 text-xs text-zinc-500">{displayPackCostLabel()}</div>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">Supply</div>
                <div className="text-2xl font-black text-white">{result.supplySnapshot.totalUnopened.toLocaleString()}</div>
                <div className="mt-1 text-xs text-zinc-500">
                  {result.supplySnapshot.depletionPct}{"% depleted of "}{result.supplySnapshot.totalPackCount.toLocaleString()}
                </div>
              </div>
            </div>

            {ttMode && ttCost !== null && (
              <div className="mb-5 rounded-xl border border-zinc-700 bg-zinc-900 p-4">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Trade Ticket Breakdown</div>
                <div className="grid gap-3 sm:grid-cols-3 text-sm">
                  <div>
                    <div className="text-zinc-500 text-xs">TTs Required</div>
                    <div className="text-white font-bold text-lg">{ttCount}</div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-xs">Floor Price per TT</div>
                    <div className="text-white font-bold text-lg">{fmt(parseFloat(ttFloor))}</div>
                    <div className="text-zinc-500 text-xs mt-0.5">Cheapest burnable across all markets</div>
                  </div>
                  <div>
                    <div className="text-zinc-500 text-xs">Total Opportunity Cost</div>
                    <div className="text-white font-bold text-lg">{fmt(ttCost)}</div>
                    <div className={"text-xs mt-0.5 " + evColor(ttIsPositive)}>
                      {ttPackEV !== null
                        ? (ttIsPositive ? "You gain " : "You lose ") + fmt(Math.abs(ttPackEV)) + " vs buying direct"
                        : ""}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mb-5 grid gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">EV by Tier</div>
                <div className="space-y-2">
                  {Object.entries(result.tierBreakdown)
                    .sort((a, b) => b[1].totalEV - a[1].totalEV)
                    .map(([tier, data]) => (
                      <div key={tier} className="flex items-center gap-3">
                        <span className={"w-20 rounded border px-2 py-0.5 text-center text-[11px] font-semibold capitalize " + tierBadge(tier)}>
                          {tier}
                        </span>
                        <div className="flex-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-zinc-400">{data.editionCount} editions · {data.remainingMoments.toLocaleString()} remaining</span>
                            <span className={"font-semibold " + tierText(tier)}>{fmt(data.totalEV)}</span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                            <div
                              className="h-full rounded-full bg-red-600"
                              style={{ width: (result.grossEV > 0 ? Math.min(100, (data.totalEV / result.grossEV) * 100) : 0) + "%" }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                </div>
                <div className="mt-3 border-t border-zinc-800 pt-3 text-[10px] text-zinc-500">{result.methodology}</div>
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Supply Snapshot</div>
                <div className="space-y-2">
                  {Object.entries(result.supplySnapshot.remainingByTier)
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([tier, remaining]) => {
                      const original = result.supplySnapshot.originalByTier[tier] ?? 0
                      const pct = original > 0 ? Math.round((remaining / original) * 100) : 0
                      return (
                        <div key={tier} className="flex items-center gap-3">
                          <span className={"w-20 rounded border px-2 py-0.5 text-center text-[11px] font-semibold capitalize " + tierBadge(tier)}>
                            {tier}
                          </span>
                          <div className="flex-1">
                            <div className="flex justify-between text-xs">
                              <span className="text-zinc-400">{remaining.toLocaleString()} of {original.toLocaleString()}</span>
                              <span className="text-zinc-300">{pct}% left</span>
                            </div>
                            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
                              <div className="h-full rounded-full bg-zinc-600" style={{ width: pct + "%" }} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                </div>
                <div className="mt-3 flex gap-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
                  <span>Status: <span className={result.supplySnapshot.forSale ? "text-green-400" : "text-red-400"}>{result.supplySnapshot.forSale ? "For Sale" : "Not For Sale"}</span></span>
                  <span>Sold Out: <span className={result.supplySnapshot.isSoldOut ? "text-red-400" : "text-green-400"}>{result.supplySnapshot.isSoldOut ? "Yes" : "No"}</span></span>
                </div>
              </div>
            </div>

            <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950">
              <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Top Pulls by EV</div>
                <div className="text-xs text-zinc-500">{result.topPulls.length} editions</div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[700px] border-collapse text-sm">
                  <thead className="bg-zinc-900">
                    <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                      <th className="p-3">Player</th>
                      <th className="p-3">Set</th>
                      <th className="p-3">Tier</th>
                      <th className="p-3">Pull Chance</th>
                      <th className="p-3">Avg Sale</th>
                      <th className="p-3">Low Ask</th>
                      <th className="p-3">Edition EV</th>
                      <th className="p-3">Remaining</th>
                      <th className="p-3">Locked %</th>
                      <th className="p-3">Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedPulls.map((edition) => (
                      <tr key={edition.editionId} className="border-b border-zinc-800 hover:bg-zinc-900/50">
                        <td className="p-3 font-medium text-white">{edition.playerName}</td>
                        <td className="p-3 text-zinc-400">{edition.setName}{edition.parallelName ? " · " + edition.parallelName : ""}</td>
                        <td className="p-3">
                          <span className={"rounded border px-2 py-0.5 text-[11px] font-semibold capitalize " + tierBadge(edition.tier)}>
                            {edition.tier}
                          </span>
                        </td>
                        <td className="p-3 text-zinc-300">{edition.probability}%</td>
                        <td className="p-3 text-zinc-300">{fmt(edition.averageSalePrice)}</td>
                        <td className="p-3 text-zinc-400">{edition.lowAsk > 0 ? fmt(edition.lowAsk) : "—"}</td>
                        <td className="p-3 font-semibold text-white">{fmt(edition.editionEV)}</td>
                        <td className="p-3 text-zinc-400">{edition.remaining} / {edition.count}</td>
                        <td className="p-3 text-zinc-400">{edition.lockedPct}%</td>
                        <td className="p-3">
                          {edition.serialPremiumLabel && (
                            <span className="rounded bg-red-950 px-2 py-0.5 text-[10px] font-semibold text-red-300">
                              {edition.serialPremiumLabel}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.topPulls.length > 5 && (
                <div className="border-t border-zinc-800 px-4 py-3">
                  <button onClick={() => setShowAllPulls((p) => !p)} className="text-xs text-zinc-400 hover:text-white">
                    {showAllPulls ? "Show fewer" : "Show all " + result.topPulls.length + " pulls"}
                  </button>
                </div>
              )}
            </div>

            {result.serialPremiumAlerts.length > 0 && (
              <div className="mb-5 rounded-xl border border-zinc-800 bg-zinc-950">
                <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Premium Serials Still in Packs</div>
                  <div className="text-xs text-zinc-500">{result.serialPremiumAlerts.length} found</div>
                </div>
                <div className="p-4">
                  <div className="flex flex-wrap gap-2">
                    {displayedAlerts.map((alert, i) => (
                      <span key={i} className="rounded-lg border border-red-900 bg-red-950/50 px-3 py-1.5 text-xs text-red-300">
                        {alert}
                      </span>
                    ))}
                  </div>
                  {result.serialPremiumAlerts.length > 8 && (
                    <button onClick={() => setShowAllAlerts((p) => !p)} className="mt-3 text-xs text-zinc-400 hover:text-white">
                      {showAllAlerts ? "Show fewer" : "Show all " + result.serialPremiumAlerts.length + " alerts"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}