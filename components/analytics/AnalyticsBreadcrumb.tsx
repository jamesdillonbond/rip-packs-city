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
  buyback: "Buyback",
  // The per-collection drill-downs (/analytics/sales/topshot, /loans/allday …)
  // use the flowty short slugs; render the collection's name, not "Topshot".
  topshot: "Top Shot",
  allday: "NFL All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC Strike",
}

// An ID segment (a set UUID, a Flow/EVM address) is not a label. Prettifying one
// printed "Bbdeb724 f790 4d6e 971e 8cf854f5de27" as the set page's title crumb and a
// raw wallet address on the wallet page (2026-10-25). Name it by its parent.
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|0x[0-9a-f]{8,}|\d+)$/i
const ID_LABEL_BY_PARENT: Record<string, string> = { sets: "Set", wallets: "Wallet" }

function pretty(slug: string, parent?: string): string {
  if (LABELS[slug]) return LABELS[slug]
  if (ID_SEGMENT.test(slug)) return (parent && ID_LABEL_BY_PARENT[parent]) ?? "Detail"
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ")
}

export default function AnalyticsBreadcrumb() {
  const pathname = usePathname() ?? "/analytics"
  const parts = pathname.split("/").filter(Boolean)

  const crumbs: { label: string; href: string }[] = [{ label: "Home", href: "/" }]
  let acc = ""
  parts.forEach((p, i) => {
    acc += "/" + p
    crumbs.push({ label: pretty(p, parts[i - 1]), href: acc })
  })

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex flex-wrap items-center gap-1 text-xs text-[color:var(--rpc-text-muted)] mb-5"
    >
      {crumbs.map((c, i) => {
        const last = i === crumbs.length - 1
        return (
          <span key={c.href} className="flex items-center gap-1">
            {i > 0 ? <ChevronRight size={12} className="text-[color:var(--rpc-text-muted)]" /> : null}
            {last ? (
              <span className="text-[color:var(--rpc-text-primary)]">{c.label}</span>
            ) : (
              <Link href={c.href} className="hover:text-red-400 transition-colors">
                {c.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
