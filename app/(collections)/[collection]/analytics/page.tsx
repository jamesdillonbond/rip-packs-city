"use client"

import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useState } from "react"

type AnalyticsResponse = {
  wallet: string
  acquisition: {
    pack_pull_count: number
    marketplace_count: number
    challenge_reward_count: number
    gift_count: number
    total_tracked: number
  }
  locked: {
    locked_count: number
    unlocked_count: number
    locked_fmv: number
    unlocked_fmv: number
  }
  tiers: Array<{ tier: string; count: number; fmv: number }>
  series: Array<{ label: string; seriesNumber: number; count: number; fmv: number }>
  confidence: Record<string, number>
  total_fmv: number
  total_moments: number
  portfolio_clarity_score: number
}

const TIER_COLOR: Record<string, string> = {
  ULTIMATE: "var(--tier-ultimate)",
  LEGENDARY: "var(--tier-legendary)",
  RARE: "var(--tier-rare)",
  FANDOM: "var(--tier-fandom)",
  COMMON: "var(--tier-common)",
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

function AnalyticsInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const collection = params?.collection as string
  const urlWallet = searchParams.get("wallet") || ""

  const [input, setInput] = useState(urlWallet)
  const [activeWallet, setActiveWallet] = useState(urlWallet)
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    setData(null)
    setActiveWallet(trimmed)
    try { router.replace(`?wallet=${encodeURIComponent(trimmed)}`, { scroll: false }) } catch {}
    try {
      const res = await fetch(`/api/analytics?wallet=${encodeURIComponent(trimmed)}`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || "Failed to load analytics")
      setData(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics")
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    if (urlWallet && !data && !loading) runSearch(urlWallet)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlWallet])

  const acq = data?.acquisition
  const acqTotal = acq ? (acq.pack_pull_count + acq.marketplace_count + acq.challenge_reward_count + acq.gift_count) : 0
  const pctPack = acq && acqTotal > 0 ? (acq.pack_pull_count / acqTotal) * 100 : 0
  const pctMarket = acq && acqTotal > 0 ? (acq.marketplace_count / acqTotal) * 100 : 0
  const pctReward = acq && acqTotal > 0 ? (acq.challenge_reward_count / acqTotal) * 100 : 0
  const pctGift = acq && acqTotal > 0 ? (acq.gift_count / acqTotal) * 100 : 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <form
        onSubmit={(e) => { e.preventDefault(); runSearch(input) }}
        className="mb-6 flex flex-col gap-2 sm:flex-row"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Wallet address or username"
          className="flex-1 rounded-lg border border-zinc-800 bg-black px-4 py-2 text-white placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none font-mono"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2 font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </form>

      {error && <div className="mb-4 rounded-lg border border-red-900/40 bg-red-950/20 p-3 text-sm text-red-300">{error}</div>}

      {!data && !loading && !error && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-8 text-center text-zinc-500">
          Enter a wallet address or Top Shot username to see portfolio analytics.
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* Section 1 — Portfolio Origin Story */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Portfolio Origin Story</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Packs Pulled</div>
                <div className="font-mono text-3xl font-black" style={{ color: "rgb(20,184,166)" }}>{acq?.pack_pull_count.toLocaleString() ?? "—"}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Marketplace Buys</div>
                <div className="font-mono text-3xl font-black text-zinc-300">{acq?.marketplace_count.toLocaleString() ?? "—"}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Challenge Rewards</div>
                <div className="font-mono text-3xl font-black" style={{ color: "rgb(245,158,11)" }}>{acq?.challenge_reward_count.toLocaleString() ?? "—"}</div>
              </div>
            </div>
            {acqTotal > 0 && (
              <div className="mt-4">
                <div className="flex h-3 w-full overflow-hidden rounded-full border border-zinc-800">
                  {pctPack > 0 && <div style={{ width: `${pctPack}%`, background: "rgb(20,184,166)" }} />}
                  {pctMarket > 0 && <div style={{ width: `${pctMarket}%`, background: "rgb(161,161,170)" }} />}
                  {pctReward > 0 && <div style={{ width: `${pctReward}%`, background: "rgb(245,158,11)" }} />}
                  {pctGift > 0 && <div style={{ width: `${pctGift}%`, background: "rgb(96,165,250)" }} />}
                </div>
                <div className="mt-2 flex flex-wrap gap-4 font-mono text-[11px] text-zinc-500">
                  <span>Pack {pctPack.toFixed(0)}%</span>
                  <span>Market {pctMarket.toFixed(0)}%</span>
                  <span>Reward {pctReward.toFixed(0)}%</span>
                  {pctGift > 0 && <span>Gift {pctGift.toFixed(0)}%</span>}
                </div>
              </div>
            )}
          </section>

          {/* Section 2 — Liquid vs Locked */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Liquid vs Locked</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Unlocked FMV</div>
                <div className="font-mono text-2xl font-black text-white">{fmt(data.locked.unlocked_fmv)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{data.locked.unlocked_count.toLocaleString()} moments</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Locked FMV</div>
                <div className="font-mono text-2xl font-black text-white">{fmt(data.locked.locked_fmv)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{data.locked.locked_count.toLocaleString()} moments</div>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-zinc-600">Locked moments cannot be listed or traded.</div>
          </section>

          {/* Section 3 — Tier Breakdown */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Tier Breakdown</div>
            <div className="space-y-2">
              {data.tiers.map((t) => {
                const maxFmv = data.tiers.reduce((m, x) => Math.max(m, x.fmv), 0)
                const w = maxFmv > 0 ? (t.fmv / maxFmv) * 100 : 0
                const color = TIER_COLOR[t.tier] ?? "var(--tier-common)"
                return (
                  <div key={t.tier} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 font-mono text-xs font-bold" style={{ color }}>{t.tier}</div>
                    <div className="relative flex-1 h-5 rounded bg-zinc-900 overflow-hidden">
                      <div className="absolute inset-y-0 left-0" style={{ width: `${w}%`, background: color, opacity: 0.35 }} />
                      <div className="absolute inset-0 flex items-center px-2 font-mono text-[11px] text-zinc-300">
                        {t.count.toLocaleString()} · {fmt(t.fmv)}
                      </div>
                    </div>
                  </div>
                )
              })}
              {data.tiers.length === 0 && <div className="text-sm text-zinc-500">No tier data.</div>}
            </div>
          </section>

          {/* Section 4 — Series Breakdown */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Series Breakdown</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                  <th className="pb-2">Series</th>
                  <th className="pb-2 text-right">Moments</th>
                  <th className="pb-2 text-right">Total FMV</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {data.series.map((s) => (
                  <tr key={s.label} className="border-b border-zinc-900">
                    <td className="py-1.5 text-zinc-300">{s.label}</td>
                    <td className="py-1.5 text-right text-zinc-400">{s.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right text-white">{fmt(s.fmv)}</td>
                  </tr>
                ))}
                {data.series.length === 0 && (
                  <tr><td colSpan={3} className="py-3 text-center text-zinc-500">No series data.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          {/* Section 5 — Portfolio Clarity Score */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
              <span>Portfolio Clarity Score</span>
              <span className="text-zinc-600" title="Share of moments with HIGH or MEDIUM FMV confidence. Higher = more reliable total portfolio FMV.">ⓘ</span>
            </div>
            <div className="font-mono text-5xl font-black text-white">{data.portfolio_clarity_score.toFixed(1)}%</div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">HIGH</div>
                <div className="text-green-400">{(data.confidence.HIGH ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">MEDIUM</div>
                <div className="text-yellow-400">{(data.confidence.MEDIUM ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">LOW</div>
                <div className="text-orange-400">{(data.confidence.LOW ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">NO DATA</div>
                <div className="text-zinc-500">{(data.confidence.NO_DATA ?? 0).toLocaleString()}</div>
              </div>
            </div>
            <div className="mt-3 text-[11px] text-zinc-600">How reliably we know this portfolio's FMV. Higher means most moments have HIGH or MEDIUM confidence pricing.</div>
          </section>
        </div>
      )}
    </div>
  )
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-6 text-zinc-500">Loading…</div>}>
      <AnalyticsInner />
    </Suspense>
  )
}
