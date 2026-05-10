"use client"

// components/TelemetryPageView.tsx
//
// Mounts in the root layout; fires a `page-view` beacon to usage_events
// on every route change. Pathname-only — no query strings — so we don't
// fan out the analytics dimension to ~∞ unique values.
//
// Static asset paths and the cart drawer's hash navigations are
// intentionally skipped so the beacon stream stays signal.

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { track } from "@/lib/telemetry/track"

const SKIP_PREFIXES = ["/_next", "/api", "/favicon", "/robots", "/sitemap", "/icons"]

export default function TelemetryPageView() {
  const pathname = usePathname() ?? "/"

  useEffect(() => {
    if (!pathname) return
    if (SKIP_PREFIXES.some((p) => pathname.startsWith(p))) return
    track("page-view", { path: pathname })
  }, [pathname])

  return null
}
