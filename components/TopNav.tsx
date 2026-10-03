"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"
import { publishedCollections } from "@/lib/collections"

interface TopNavLink {
  label: string
  href: string
  matchPrefix?: string
}

// The collection links are DERIVED from the registry (2026-09-06) — this list
// was hand-written and silently omitted Candy MLB the day it published, while
// the switcher, footer and mobile sheet (all registry-driven) carried it.
const LINKS: TopNavLink[] = [
  ...publishedCollections().map((c) => ({
    // "Strike" is the switcher chip; the top nav has always said UFC.
    label: c.id === "ufc" ? "UFC" : c.shortLabel,
    href: `/${c.id}/overview`,
    matchPrefix: `/${c.id}`,
  })),
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
    // 2026-10-03: between 768 and ~1000 px the row squeezed this nav and the
    // two-word labels wrapped INSIDE their link ("Top" over "Shot", "All" over
    // "Day") — measured in Trevor's Chrome at 995 px and in headless Chromium
    // at 900/1000 px (two link rows). The nav no longer shrinks and its labels
    // never wrap; at md the gaps and padding tighten so the whole row (logo +
    // nav + search ≥ 110 px + toggle + SIGN IN) still fits at 768 px with the
    // signed-in extras (My Teams, Alerts). Simulated on the live header before
    // shipping: 0 overflow and one link row at every width 768–1100.
    <nav className="hidden md:flex items-center shrink-0 md:gap-0 lg:gap-1 text-sm">
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
              "rounded-md md:px-1.5 lg:px-2.5 py-1.5 whitespace-nowrap transition-colors font-medium tracking-wide " +
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
