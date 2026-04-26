import type { Metadata } from "next"
import Link from "next/link"
import { ArrowUpRight, Book } from "lucide-react"
import { METHODOLOGY_LIST } from "@/lib/analytics/methodology"
import { analyticsMetadata } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Methodology — How We Compute Rip Packs City Analytics",
  description:
    "Methodology for every analytic published on Rip Packs City. Read how we ingest, compute, and refresh on-chain data for Flow collectibles.",
  path: "/analytics/methodology",
})

export default function MethodologyIndexPage() {
  return (
    <div className="space-y-6">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20">
          <Book size={18} className="text-emerald-400" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-50 tracking-tight">Methodology</h1>
          <p className="text-sm text-slate-400">
            How every metric on Rip Packs City Analytics is computed.
          </p>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2">
        {METHODOLOGY_LIST.map((m) => (
          <Link
            key={m.slug}
            href={`/analytics/methodology/${m.slug}`}
            className="group rounded-xl border border-slate-800 bg-slate-900/40 p-5 transition-all hover:border-emerald-500/40 hover:bg-slate-900/70"
          >
            <div className="flex items-start justify-between mb-2">
              <h2 className="font-semibold text-slate-100">{m.title}</h2>
              <ArrowUpRight
                size={14}
                className="text-slate-600 group-hover:text-emerald-400 transition-colors mt-1"
              />
            </div>
            <p className="text-sm text-slate-400 leading-relaxed mb-3">{m.blurb}</p>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Refresh · {m.refresh}
            </div>
          </Link>
        ))}
      </div>
    </div>
  )
}
