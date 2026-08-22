"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { type Collection, type CollectionPage, PAGE_LABELS, tabBarPages } from "@/lib/collections"

export function CollectionTabBar({ collection }: { collection: Collection }) {
  const pathname = usePathname()

  return (
    <nav
      className="rpc-coll-tabs"
      style={{ display: "flex", gap: 2, marginTop: 8, overflowX: "auto" }}
      role="tablist"
    >
      {tabBarPages(collection).map((page: CollectionPage) => {
        const href = `/${collection.id}/${page}`
        const isActive =
          pathname === href ||
          (page === "overview" && pathname === `/${collection.id}`)

        return (
          <Link
            key={page}
            href={href}
            role="tab"
            aria-selected={isActive}
            className="rpc-coll-tab"
            // FirstRunTour anchors the "Real-time deal flow" step on the
            // sniper nav link; other tabs aren't anchored.
            data-tour-anchor={page === "sniper" ? "sniper-nav-link" : undefined}
            style={{
              // ⚠ MEASURED 35px tall (Chromium, 2026-08-22) — under the 44px
              // floor (§9 / WCAG 2.5.5) on the PRIMARY navigation, where a
              // mis-tap costs a page load rather than a re-tap.
              //
              // This one GROWS THE BOX rather than using .rpc-tap44's invisible
              // overlay, and the reason is measured too: the overlay's lower
              // half hit-tested to `main.rpc-main`, which follows the nav in DOM
              // order and paints over an un-z-indexed absolute child. Lifting
              // the nav above `main` to win that would put a 4.5px invisible
              // strip over the top of the page content — trading a nav mis-tap
              // for a content one. Tabs are also the control that SHOULD look
              // chunkier, so the visible change is the right one here.
              minHeight: 44,
              display: "inline-flex",
              alignItems: "center",
              padding: "8px 14px",
              fontSize: 11,
              fontFamily: "var(--font-display)",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: isActive ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
              textDecoration: "none",
              borderRadius: "4px 4px 0 0",
              background: isActive ? "var(--rpc-surface-hover)" : "transparent",
              borderBottom: isActive ? `2px solid ${collection.accent}` : "2px solid transparent",
              transition: "all 0.15s",
              whiteSpace: "nowrap",
              flexShrink: 0,
            }}
          >
            {PAGE_LABELS[page]}
          </Link>
        )
      })}
    </nav>
  )
}