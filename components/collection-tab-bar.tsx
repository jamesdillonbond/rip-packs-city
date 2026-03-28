"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { type Collection, type CollectionPage, PAGE_LABELS } from "@/lib/collections"

export function CollectionTabBar({ collection }: { collection: Collection }) {
  const pathname = usePathname()

  return (
    <nav
      className="rpc-coll-tabs"
      style={{ display: "flex", gap: 2, marginTop: 8, overflowX: "auto" }}
      role="tablist"
    >
      {collection.pages.map((page: CollectionPage) => {
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
            style={{
              padding: "8px 14px",
              fontSize: 11,
              fontFamily: "'Barlow Condensed', sans-serif",
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: isActive ? "#fff" : "rgba(255,255,255,0.45)",
              textDecoration: "none",
              borderRadius: "4px 4px 0 0",
              background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
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