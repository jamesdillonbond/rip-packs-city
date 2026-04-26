"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

interface TopNavLink {
  label: string
  href: string
  matchPrefix?: string
}

const LINKS: TopNavLink[] = [
  { label: "Top Shot", href: "/nba-top-shot/overview", matchPrefix: "/nba-top-shot" },
  { label: "All Day", href: "/nfl-all-day/overview", matchPrefix: "/nfl-all-day" },
  { label: "Golazos", href: "/laliga-golazos/overview", matchPrefix: "/laliga-golazos" },
  { label: "Pinnacle", href: "/disney-pinnacle/overview", matchPrefix: "/disney-pinnacle" },
  { label: "Analytics", href: "/analytics", matchPrefix: "/analytics" },
]

export default function TopNav() {
  const pathname = usePathname() ?? "/"
  return (
    <nav className="hidden md:flex items-center gap-1 text-sm">
      {LINKS.map((l) => {
        const active = l.matchPrefix
          ? pathname === l.matchPrefix || pathname.startsWith(l.matchPrefix + "/")
          : pathname === l.href
        const isAnalytics = l.label === "Analytics"
        return (
          <Link
            key={l.href}
            href={l.href}
            className={
              "rounded-md px-2.5 py-1.5 transition-colors font-medium tracking-wide " +
              (active
                ? isAnalytics
                  ? "text-emerald-400 bg-emerald-500/10"
                  : "text-white bg-white/5"
                : "text-white/55 hover:text-white hover:bg-white/5")
            }
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
