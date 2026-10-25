"use client"

// components/SkipToContentLink.tsx
//
// The skip link's client half (2026-10-24). The root layout's MainContentAnchor
// sits before {children}, but 13 layouts mount GlobalSiteHeader INSIDE children
// — so the plain fragment jump landed ABOVE the logo, nav, search, ticker and
// collection tabs it exists to skip (UI audit 2026-10-24, P1-1). Layouts with
// chrome now render <PageContentAnchor /> after it; on activation this focuses
// the LAST such anchor in document order (the deepest layout's), and falls back
// to the native #main-content jump when a page has none (or JS has not loaded).

import type { MouseEvent, ReactNode } from "react"
import { PAGE_CONTENT_ANCHOR_ATTR } from "@/components/skip-to-content-attr"

export default function SkipToContentLink({ href, className, children }: { href: string; className: string; children: ReactNode }) {
  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    const anchors = document.querySelectorAll<HTMLElement>(`[${PAGE_CONTENT_ANCHOR_ATTR}]`)
    const target = anchors[anchors.length - 1]
    if (!target) return // native fragment jump to the root anchor
    e.preventDefault()
    target.focus()
  }
  return (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  )
}
