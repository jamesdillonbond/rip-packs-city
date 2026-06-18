"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"

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
  { label: "UFC", href: "/ufc/overview", matchPrefix: "/ufc" },
  { label: "Analytics", href: "/analytics", matchPrefix: "/analytics" },
  { label: "Blog", href: "/blog", matchPrefix: "/blog" },
]

// "My Teams" is the auth-gated fan hub (Team Hub Phase 5), so it is only shown
// to signed-in users — a logged-out visitor would just bounce to /login.
const MY_TEAMS: TopNavLink = { label: "My Teams", href: "/my-teams", matchPrefix: "/my-teams" }

// "Alerts" is the auth-gated omni-channel alerts hub (/alerts). Like My Teams it
// is signed-in only — anon would bounce to /login. This is the primary front
// door to the alerts feature; without it the page is undiscoverable in nav.
const ALERTS: TopNavLink = { label: "Alerts", href: "/alerts", matchPrefix: "/alerts" }

export default function TopNav() {
  const pathname = usePathname() ?? "/"
  const [signedIn, setSignedIn] = useState(false)

  useEffect(() => {
    let active = true
    const supabase = getSupabaseBrowser()
    supabase.auth.getUser().then(({ data }: { data: { user: unknown } | null }) => {
      if (active) setSignedIn(!!data?.user)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event: string, session: { user?: unknown } | null) => {
      if (active) setSignedIn(!!session?.user)
    })
    return () => {
      active = false
      sub?.subscription?.unsubscribe()
    }
  }, [])

  const links = signedIn ? [...LINKS, MY_TEAMS, ALERTS] : LINKS

  return (
    <nav className="hidden md:flex items-center gap-1 text-sm">
      {links.map((l) => {
        const active = l.matchPrefix
          ? pathname === l.matchPrefix || pathname.startsWith(l.matchPrefix + "/")
          : pathname === l.href
        const isAnalytics = l.label === "Analytics"
        const isMyTeams = l.label === "My Teams"
        return (
          <Link
            key={l.href}
            href={l.href}
            className={
              "rounded-md px-2.5 py-1.5 transition-colors font-medium tracking-wide " +
              (active
                ? isAnalytics
                  ? "text-emerald-400 bg-emerald-500/10"
                  : isMyTeams
                    ? "text-[color:var(--rpc-text-primary)] bg-[var(--rpc-red)]/15"
                    : "text-[color:var(--rpc-text-primary)] bg-[color:var(--rpc-surface-hover)]"
                : "text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)]")
            }
          >
            {l.label}
          </Link>
        )
      })}
    </nav>
  )
}
