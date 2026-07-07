"use client"

// Cross-collection holdings card for the collection analytics page. Behavior-
// preserving verbatim extraction — resolves a username to its public profile,
// buckets wallet moment counts by collection, and renders linked accent chips.
import Link from "next/link"
import { useEffect, useState } from "react"
import { getCollectionByUuid } from "@/lib/collections"

export default function CrossCollectionHoldingsCard({ usernameInput }: { usernameInput: string }) {
  const [bundle, setBundle] = useState<any | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!usernameInput || usernameInput.startsWith("0x")) { setMissing(true); return }
    let cancelled = false
    fetch(`/api/public/profile/${encodeURIComponent(usernameInput.replace(/^@+/, ""))}`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => { if (!cancelled && j) setBundle(j) })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [usernameInput])
  if (missing || !bundle?.wallets) return null
  // Bucket wallets by collection_id, summing cached_moment_count.
  const buckets = new Map<string, number>()
  for (const w of bundle.wallets as Array<any>) {
    const cid = String(w.collection_id || "unknown")
    buckets.set(cid, (buckets.get(cid) ?? 0) + (Number(w.cached_moment_count) || 0))
  }
  if (buckets.size === 0) return null
  // Resolve UUID → Collection so we can render real labels + accent dots and link
  // to that collection's analytics page. Sort by moment count descending.
  const enriched = Array.from(buckets.entries())
    .map(([cid, count]) => {
      const c = getCollectionByUuid(cid)
      return {
        cid,
        count,
        collection: c,
        label: c?.label ?? "Unknown collection",
        accent: c?.accent ?? "var(--rpc-text-muted)",
        href: c ? `/${c.id}/analytics` : null,
      }
    })
    .sort((a, b) => b.count - a.count)
  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
        Cross-Collection Holdings
      </h2>
      <div className="flex flex-wrap gap-2">
        {enriched.map((row) => {
          const inner = (
            <>
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: row.accent }} />
              <span className="text-[color:var(--rpc-text-primary)]">{row.label}</span>
              <span className="text-[color:var(--rpc-text-muted)]">·</span>
              <span className="text-[color:var(--rpc-text-secondary)]">{row.count.toLocaleString()} moments</span>
            </>
          )
          const baseClass = "inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px]"
          const baseStyle = { border: "1px solid var(--rpc-border)", background: "var(--rpc-surface)", fontFamily: "var(--font-mono)" } as const
          return row.href ? (
            <Link
              key={row.cid}
              href={`${row.href}?wallet=${encodeURIComponent(usernameInput.replace(/^@+/, ""))}`}
              className={`${baseClass} transition-colors hover:bg-[var(--rpc-surface)]`}
              style={baseStyle}
            >
              {inner}
            </Link>
          ) : (
            <span key={row.cid} className={baseClass} style={baseStyle}>
              {inner}
            </span>
          )
        })}
      </div>
    </section>
  )
}
