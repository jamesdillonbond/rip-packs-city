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

export function onTheBlockHref(collection: string, name: string, edition?: string | null): string {
  const base = `/trades/block?collection=${encodeURIComponent(collection)}`
  return edition ? `${base}&edition=${encodeURIComponent(edition)}` : `${base}&q=${encodeURIComponent(name)}`
}

/**
 * `edition` (a catalog key) scopes it to listings that offer a copy of that edition or want
 * it — the edition page's form; without it, any listing naming the player / character.
 */
export default function OnTheBlockLink({ collection, name, edition = null }: { collection: string; name: string; edition?: string | null }) {
  const [count, setCount] = useState<{ n: number; more: boolean } | null>(null)
  const supported = collectionBySlug(collection) !== null && (edition ? edition.length <= 120 : name.trim().length >= 2)

  useEffect(() => {
    if (!supported) return
    let live = true
    const qs = new URLSearchParams(edition ? { collection, edition } : { collection, q: name.trim() })
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
  }, [collection, name, edition, supported])

  if (!count) return null
  const one = count.n === 1 && !count.more
  const label = edition
    ? `${count.n}${count.more ? "+" : ""} open Trade Block listing${one ? "" : "s"} offer${one ? "s" : ""} or want${one ? "s" : ""} this edition`
    : `${count.n}${count.more ? "+" : ""} open Trade Block listing${one ? "" : "s"} mention${one ? "s" : ""} ${name}`
  return (
    <Link
      href={onTheBlockHref(collection, name, edition)}
      data-rpc-on-the-block
      style={{ display: "inline-block", marginTop: edition ? 0 : 8, marginLeft: edition ? 0 : 12, fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--rpc-red-text)", textDecoration: "none" }}
    >
      {label} →
    </Link>
  )
}
