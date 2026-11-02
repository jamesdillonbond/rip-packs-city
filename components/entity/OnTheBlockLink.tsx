"use client"

// components/entity/OnTheBlockLink.tsx
//
// "N open Trade Block listings mention <player> →" on a player / character page
// (2026-11-02, Trade Block v3). Reads the public block once on mount, scoped to this
// collection and name. DECORATIVE: it renders only on a successful read that found at
// least one listing — a failed read or an empty one renders nothing, so the page never
// claims "nobody is trading this player" from an outage (or at all).

import { useEffect, useState } from "react"
import Link from "next/link"
import { collectionBySlug } from "@/lib/trade-block/rules"

export function onTheBlockHref(collection: string, name: string): string {
  return `/trades/block?collection=${encodeURIComponent(collection)}&q=${encodeURIComponent(name)}`
}

export default function OnTheBlockLink({ collection, name }: { collection: string; name: string }) {
  const [count, setCount] = useState<{ n: number; more: boolean } | null>(null)
  const supported = collectionBySlug(collection) !== null && name.trim().length >= 2

  useEffect(() => {
    if (!supported) return
    let live = true
    const qs = new URLSearchParams({ collection, q: name.trim() })
    fetch(`/api/public/trade-block?${qs.toString()}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) return null
        const j = (await r.json()) as { listings?: unknown; next_before?: unknown }
        return Array.isArray(j?.listings) ? { n: j.listings.length, more: typeof j.next_before === "string" } : null
      })
      .catch(() => null)
      .then((c) => {
        if (live && c && c.n > 0) setCount(c)
      })
    return () => {
      live = false
    }
  }, [collection, name, supported])

  if (!count) return null
  const one = count.n === 1 && !count.more
  const label = `${count.n}${count.more ? "+" : ""} open Trade Block listing${one ? "" : "s"} mention${one ? "s" : ""} ${name}`
  return (
    <Link
      href={onTheBlockHref(collection, name)}
      data-rpc-on-the-block
      style={{ display: "inline-block", marginTop: 8, marginLeft: 12, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-red-text)", textDecoration: "none" }}
    >
      {label} →
    </Link>
  )
}
