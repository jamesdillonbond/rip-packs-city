"use client"

// PackSubNav — the in-page "Moments | Packs" sub-toggle that lives under the
// Collection / Market / Sniper top-level tabs after the 2026-07-18 IA reorg.
//
// It is URL-param driven (`?section=packs`) so the sub-views stay deep-linkable
// and crawlable, and so the top-level tab bar keeps highlighting the parent tab
// (Market/Sniper/Collection) — the whole point of the in-page-toggle approach
// over nested routes. NOTE the market page already owns `?view=` (grid/table),
// which is why the sub-toggle uses `?section=` and not `?view=`.
//
// Presentational + self-navigating: it reads the param and drives the router.
// The parent page reads the same param independently to decide which body to
// mount, so the two stay decoupled. "Moments" is relabeled "Pins" for Pinnacle.

import { useCallback } from "react"
import { useRouter, useSearchParams } from "next/navigation"

export type PackSubSection = "moments" | "packs"

/** Read the active sub-section from the URL. `moments` is the default. */
export function subSectionFromParams(
  searchParams: URLSearchParams | { get(k: string): string | null },
): PackSubSection {
  return searchParams.get("section") === "packs" ? "packs" : "moments"
}

export function PackSubNav({
  accent,
  active,
  momentsLabel = "Moments",
  packsLabel = "Packs",
}: {
  accent: string
  active: PackSubSection
  /** "Moments" everywhere except Pinnacle, which uses "Pins". */
  momentsLabel?: string
  packsLabel?: string
}) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const go = useCallback(
    (next: PackSubSection) => {
      const sp = new URLSearchParams(searchParams.toString())
      if (next === "packs") sp.set("section", "packs")
      else sp.delete("section")
      const qs = sp.toString()
      router.replace(qs ? `?${qs}` : "?", { scroll: false })
    },
    [router, searchParams],
  )

  const items: Array<{ key: PackSubSection; label: string }> = [
    { key: "moments", label: momentsLabel },
    { key: "packs", label: packsLabel },
  ]

  return (
    <nav
      role="tablist"
      aria-label="Moments or Packs"
      style={{
        display: "inline-flex",
        gap: 4,
        padding: 3,
        borderRadius: "var(--radius-sm)",
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
      }}
    >
      {items.map(({ key, label }) => {
        const on = active === key
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => go(key)}
            className="rpc-mono"
            style={{
              padding: "6px 16px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              borderRadius: "calc(var(--radius-sm) - 2px)",
              border: "none",
              cursor: "pointer",
              background: on ? accent : "transparent",
              color: on ? "#fff" : "var(--rpc-text-muted)",
              transition: "background 0.15s, color 0.15s",
            }}
          >
            {label}
          </button>
        )
      })}
    </nav>
  )
}
