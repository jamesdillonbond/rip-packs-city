"use client"

interface LeaderboardRow {
  rank: number
  address: string
  username: string
  loanCount: number
  totalUsd: number
  isReturning: boolean
}

interface LeaderboardTableProps {
  rows: LeaderboardRow[]
  role: "lender" | "borrower"
  window: string
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function truncate(addr: string): string {
  const a = (addr || "").toLowerCase()
  if (!a.startsWith("0x")) return a
  if (a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

function identicon(addr: string): string {
  // Pick deterministic emerald/sky/amber tints from the address.
  const hex = (addr || "").replace(/[^0-9a-f]/gi, "").slice(-6) || "10b981"
  return `#${hex}`
}

export default function LeaderboardTable({ rows, role, window }: LeaderboardTableProps) {
  const title = role === "lender" ? "Top Lenders" : "Top Borrowers"
  const badge = role === "lender" ? "Capital deployed" : "Liquidity sourced"
  const badgeColor =
    role === "lender" ? "border-emerald-500/30 text-emerald-400" : "border-sky-500/30 text-sky-400"

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 flex flex-col">
      <div className="flex items-center justify-between p-4 border-b border-slate-800">
        <div>
          <h3 className="font-semibold text-slate-100">{title}</h3>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mt-0.5">
            {window}
          </div>
        </div>
        <span
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold ${badgeColor}`}
        >
          {badge}
        </span>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 420 }}>
        {rows.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">
            No {role === "lender" ? "lender" : "borrower"} activity in this window yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-900/80 backdrop-blur">
              <tr className="text-[10px] uppercase tracking-widest text-slate-500 border-b border-slate-800">
                <th className="py-2 px-3 text-left font-semibold w-8">#</th>
                <th className="py-2 px-3 text-left font-semibold">Wallet</th>
                <th className="py-2 px-3 text-right font-semibold">Loans</th>
                <th className="py-2 px-3 text-right font-semibold">Volume</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.address} className="border-b border-slate-800/40 last:border-b-0">
                  <td className="py-2.5 px-3 text-slate-500 tabular-nums">{r.rank}</td>
                  <td className="py-2.5 px-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="h-5 w-5 rounded-full flex-shrink-0 ring-1 ring-slate-700"
                        style={{ background: identicon(r.address) }}
                      />
                      <div className="min-w-0">
                        <div className="text-slate-200 truncate" title={r.address}>
                          {r.username}
                        </div>
                        {r.username !== truncate(r.address) ? (
                          <div className="text-[10px] text-slate-500 font-mono truncate">
                            {truncate(r.address)}
                          </div>
                        ) : null}
                      </div>
                      {r.isReturning ? (
                        <span className="ml-auto rounded border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-emerald-400 flex-shrink-0">
                          Repeat
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                    {r.loanCount}
                  </td>
                  <td className="py-2.5 px-3 text-right text-slate-100 tabular-nums font-medium">
                    {formatUsd(r.totalUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
