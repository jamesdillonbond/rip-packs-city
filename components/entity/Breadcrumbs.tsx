// components/entity/Breadcrumbs.tsx
// Phase 2B. Visible breadcrumb trail for the entity detail pages. The
// human-readable counterpart to the BreadcrumbList JSON-LD emitted by
// lib/seo.ts — Google can render breadcrumb sitelinks from the structured
// data, and the visible trail improves internal linking / crawl depth.
//
// Server component (no client JS). Each item except the last is a Link;
// the last item is the current page, rendered as plain text. Pass relative
// hrefs (e.g. "/nba-top-shot/set/base-set").

import Link from "next/link"

export interface Crumb {
  name: string
  /** Relative href; omit (or null) for the current/last item. */
  href?: string | null
}

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  const trail = items.filter((c) => c.name && c.name.length > 0)
  if (trail.length === 0) return null
  return (
    <nav
      aria-label="Breadcrumb"
      className="rpc-mono"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        marginBottom: 12,
        fontSize: 11,
        letterSpacing: "0.04em",
        color: "var(--rpc-text-muted)",
      }}
    >
      {trail.map((c, i) => {
        const isLast = i === trail.length - 1
        return (
          <span key={`${c.name}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
            {c.href && !isLast ? (
              <Link
                href={c.href}
                style={{ color: "var(--rpc-text-secondary)", textDecoration: "none", whiteSpace: "nowrap" }}
              >
                {c.name}
              </Link>
            ) : (
              <span
                aria-current={isLast ? "page" : undefined}
                style={{
                  color: isLast ? "var(--rpc-text-primary)" : "var(--rpc-text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 360,
                }}
              >
                {c.name}
              </span>
            )}
            {!isLast && <span aria-hidden="true" style={{ color: "var(--rpc-text-ghost)" }}>›</span>}
          </span>
        )
      })}
    </nav>
  )
}
