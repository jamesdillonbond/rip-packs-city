"use client"
import { useState, useEffect, useCallback } from "react"

interface Offer {
  nftId: string
  playerName?: string
  amount: number
  fmv: number | null
  buyer: string
  offerResourceId: string
  timestamp: string
}

export default function OffersTab() {
  const [offers, setOffers] = useState<Offer[]>([])
  const [loading, setLoading] = useState(true)

  const fetchOffers = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/flowty-offers")
      if (res.ok) { const d = await res.json(); setOffers(d.offers ?? []) }
    } catch {}
    setLoading(false)
  }, [])

  useEffect(() => { fetchOffers() }, [fetchOffers])

  if (loading) return <div className="py-16 text-center text-slate-500 text-sm">Loading offers…</div>
  if (offers.length === 0) return <div className="py-16 text-center text-slate-500 text-sm">No open offers found</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs text-slate-500">{offers.length} open offers</span>
        <button onClick={fetchOffers} className="text-xs px-3 py-1.5 rounded-lg border text-[#E03A2F] border-[#E03A2F]/40 bg-[#E03A2F]/10 hover:bg-[#E03A2F]/20 transition-colors">↻ Refresh</button>
      </div>
      <div className="overflow-x-auto rounded-xl border border-slate-800/60">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800/60 bg-slate-900/60">
              <th className="text-left px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Moment</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Offer</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">FMV</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">vs FMV</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Buyer</th>
              <th className="text-right px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/40">
            {offers.map((o, i) => {
              const pctNum = o.fmv && o.fmv > 0 ? Math.round((o.amount / o.fmv) * 100) : null
              const isAbove = pctNum !== null && pctNum >= 100
              return (
                <tr key={o.offerResourceId + i} className="hover:bg-slate-800/30 transition-colors">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-slate-200">{o.playerName ?? ("NFT #" + o.nftId)}</div>
                    <div className="text-xs text-slate-500">Flow ID: {o.nftId}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-400">{"$"}{Number(o.amount).toFixed(2)}</td>
                  <td className="px-3 py-2 text-right font-mono text-slate-400">{o.fmv ? ("$" + Number(o.fmv).toFixed(2)) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {pctNum !== null ? (
                      <span className={"text-xs font-bold px-2 py-0.5 rounded " + (isAbove ? "bg-emerald-500/15 text-emerald-400" : "bg-slate-700/50 text-slate-400")}>{pctNum}% of FMV</span>
                    ) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-slate-500">{o.buyer ? o.buyer.slice(0,8) + "…" : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <a href={"https://www.flowty.io/offer/" + o.offerResourceId} target="_blank" rel="noopener noreferrer"
                      className="text-xs px-3 py-1.5 rounded-lg border text-[#00D4AA] border-[#00D4AA]/40 bg-[#00D4AA]/10 hover:bg-[#00D4AA]/20 transition-colors">
                      View →
                    </a>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}