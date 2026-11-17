"use client"

import Link from "next/link"
import { useSyncExternalStore } from "react"
import { readRecordedLastCollection } from "@/lib/active-collection"
import { getCollection } from "@/lib/collections"

// "Back to <collection> <Page>" on a hub (/sniper, /market) for a returning
// collector, so the hub is never an extra hop for someone who lives in one
// collection. Rendered only when a last collection was actually RECORDED and it
// has that page — never a default, and never a redirect (the hub stays visible).
export default function LastCollectionShortcut({ page, label }: { page: "sniper" | "market"; label: string }) {
  // localStorage is an external store: null on the server and at hydration,
  // so SSR never renders a shortcut it cannot know about.
  const id = useSyncExternalStore(
    (cb) => {
      window.addEventListener("storage", cb)
      return () => window.removeEventListener("storage", cb)
    },
    readRecordedLastCollection,
    () => null,
  )
  const c = id ? getCollection(id) : undefined
  if (!c || !c.published || !c.pages.includes(page)) return null
  return (
    <Link
      href={`/${c.id}/${page}`}
      data-testid="last-collection-shortcut"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        minHeight: 48,
        padding: "0 16px",
        borderRadius: 8,
        border: `1px solid ${c.accent}`,
        background: "var(--rpc-surface-raised)",
        color: "var(--rpc-text-primary)",
        textDecoration: "none",
        fontFamily: "var(--font-display)",
        fontWeight: 800,
        fontSize: 14,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      <span>
        <span aria-hidden="true" style={{ marginRight: 8 }}>{c.icon}</span>
        Back to {c.shortLabel} {label}
      </span>
      <span aria-hidden="true">→</span>
    </Link>
  )
}
