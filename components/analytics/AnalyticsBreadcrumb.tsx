"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ChevronRight } from "lucide-react"

const LABELS: Record<string, string> = {
  analytics: "Analytics",
  loans: "Loans",
  pulse: "Pulse",
  sales: "Sales",
  listings: "Listings",
  wallets: "Wallets",
  packs: "Packs",
  sets: "Sets",
  fmv: "FMV Index",
  api: "Public API",
  methodology: "Methodology",
}

function pretty(slug: string): string {
  if (LABELS[slug]) return LABELS[slug]
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ")
}

export default function AnalyticsBreadcrumb() {
  const pathname = usePathname() ?? "/analytics"
  const parts = pathname.split("/").filter(Boolean)

  const crumbs: { label: string; href: string }[] = [{ label: "Home", href: "/" }]
  let acc = ""
  for (const p of parts) {
    acc += "/" + p
    crumbs.push({ label: pretty(p), href: acc })
  }

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1 text-xs text-slate-500 mb-5"
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1
        return (
          <span key={c.href} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight size={12} className="text-slate-700" /> : null}
            {last ? (
              <span className="text-slate-300">{c.label}</span>
            ) : (
              <Link href={c.href} className="hover:text-emerald-400 transition-colors">
                {c.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
