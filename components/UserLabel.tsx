"use client"

// Item 3 (2026-06-09): one place to render a Flow wallet as a Top Shot @handle
// with a graceful truncated-address fallback. Presentational only — the parent
// collects the table's addresses, calls useResolveUsernames(addrs) once, and
// passes names[addr.toLowerCase()] into each <UserLabel>. This matches the
// established LeaderboardTable pattern (one batched fetch, not one per row).

import Link from "next/link"
import { truncateAddress } from "@/lib/analytics/username-resolver"

export function UserLabel({
  address,
  name,
  link = false,
  className,
  emptyLabel = "—",
}: {
  address: string | null | undefined
  /** Resolved username for this address, if known (from useResolveUsernames). */
  name?: string | null
  /** Wrap in a link to the public profile (/profile/<addr>). */
  link?: boolean
  className?: string
  emptyLabel?: string
}) {
  if (!address) return <span className={className}>{emptyLabel}</span>
  const lower = address.toLowerCase()
  const hasName = !!name
  const label = hasName ? `@${name}` : truncateAddress(lower)
  const title = hasName ? `${name} · ${lower}` : lower

  const inner = (
    <span
      className={className}
      title={title}
      style={hasName ? undefined : { fontFamily: "var(--font-mono)" }}
    >
      {label}
    </span>
  )

  if (link) {
    return (
      <Link href={`/profile/${lower}`} className="hover:underline">
        {inner}
      </Link>
    )
  }
  return inner
}
