"use client"

// components/collection/PaniniScopeBar.tsx
//
// "League or brand" — the scope a visitor picks once and every Panini tab respects (2026-11-26):
// All · FIFA World Cup · NBA · NFL · WNBA · … It is carried as `?property=<slug>` and remembered in
// localStorage, so moving from Sniper to Packs keeps it. Each tab filters its own rows by the Panini set id
// they carry (lib/panini/scope.ts). ⛔ The word "property" never renders.
//
// HONESTY: if the scope index cannot be read, the bar renders nothing and NO tab is filtered — and a tab that
// was opened with ?property= says the filter could not be applied rather than showing an unfiltered list as
// if it were the league's.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import {
  PANINI_SCOPE_EVENT,
  PANINI_SCOPE_PARAM,
  PANINI_SCOPE_STORAGE_KEY,
  cleanScopeSlug,
  toScopeIndex,
  type PaniniScopeIndex,
} from "@/lib/panini/scope"

function subscribeAsk(onChange: () => void): () => void {
  window.addEventListener(PANINI_SCOPE_EVENT, onChange)
  window.addEventListener("popstate", onChange)
  return () => {
    window.removeEventListener(PANINI_SCOPE_EVENT, onChange)
    window.removeEventListener("popstate", onChange)
  }
}
const subscribeNothing = () => () => {}
const readNothing = () => ""

export interface PaniniScope {
  /** null until read; stays null when the read failed (see `failed`). */
  index: PaniniScopeIndex | null
  failed: boolean
  /** The chosen slug, "" = everything. Only ever a slug the index knows (or the raw ask while it loads). */
  slug: string
  /** Its display name; null for "" or while unknown. */
  name: string | null
  /** True when a scope is asked for but cannot be applied yet/at all (index loading or failed). */
  pending: boolean
  setSlug: (slug: string) => void
}

function readAsk(): string {
  if (typeof window === "undefined") return ""
  try {
    const fromUrl = cleanScopeSlug(new URLSearchParams(window.location.search).get(PANINI_SCOPE_PARAM))
    if (fromUrl) return fromUrl
    return cleanScopeSlug(window.localStorage.getItem(PANINI_SCOPE_STORAGE_KEY))
  } catch {
    return ""
  }
}

/** `enabled: false` (a shared client on another collection) reads nothing and never scopes. */
export function usePaniniScope(enabled: boolean = true): PaniniScope {
  const [index, setIndex] = useState<PaniniScopeIndex | null>(null)
  const [failed, setFailed] = useState(false)
  // The ask lives in the URL and localStorage (external stores), so every Panini tab on the page agrees and
  // the server render ("" = no scope) hydrates cleanly.
  const ask = useSyncExternalStore(enabled ? subscribeAsk : subscribeNothing, enabled ? readAsk : readNothing, readNothing)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    fetchJson<unknown>("/api/panini-properties").then((r) => {
      if (cancelled) return
      const parsed = r.ok ? toScopeIndex(r.json) : null
      if (parsed) setIndex(parsed)
      else setFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [enabled])

  const setSlug = useCallback((next: string) => {
    const slug = cleanScopeSlug(next)
    try {
      if (slug) window.localStorage.setItem(PANINI_SCOPE_STORAGE_KEY, slug)
      else window.localStorage.removeItem(PANINI_SCOPE_STORAGE_KEY)
      const url = new URL(window.location.href)
      if (slug) url.searchParams.set(PANINI_SCOPE_PARAM, slug)
      else url.searchParams.delete(PANINI_SCOPE_PARAM)
      window.history.replaceState(window.history.state, "", url.toString())
    } catch {
      // Storage or history unavailable: the choice is not kept.
    }
    window.dispatchEvent(new Event(PANINI_SCOPE_EVENT))
  }, [])

  return useMemo(() => {
    const known = index && ask ? index.properties.find((p) => p.slug === ask) ?? null : null
    // An ask the index does not know is dropped once the index is in (a stale stored slug must not hide every row).
    const slug = index ? (known ? ask : "") : ask
    return { index, failed, slug, name: known?.name ?? null, pending: !!ask && !index, setSlug }
  }, [index, failed, ask, setSlug])
}

const chip = (on: boolean): React.CSSProperties => ({
  fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", cursor: "pointer",
  padding: "6px 10px", borderRadius: 6, minHeight: 32, whiteSpace: "nowrap",
  background: on ? "var(--rpc-red-bg)" : "var(--rpc-surface)",
  border: `1px solid ${on ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
  color: "var(--rpc-text-primary)",
})

/**
 * The chip row. `counts` = rows per slug in THIS tab (chips show only leagues / brands the tab has rows for,
 * plus the chosen one); omit it to show every league / brand without counts. `total` = the tab's row count.
 */
export default function PaniniScopeBar({ scope, counts, total }: { scope: PaniniScope; counts?: Map<string, number>; total?: number }) {
  if (!scope.index) {
    return scope.pending && scope.failed ? (
      <div role="status" data-testid="panini-scope-unavailable" className="rpc-mono" style={{ margin: "10px 0 0", fontSize: 11, color: "var(--rpc-text-muted)" }}>
        The league filter couldn&rsquo;t load, so this list is not filtered.
      </div>
    ) : null
  }
  const options = scope.index.properties
    .filter((p) => !counts || (counts.get(p.slug) ?? 0) > 0 || p.slug === scope.slug)
    .sort((a, b) => (counts ? (counts.get(b.slug) ?? 0) - (counts.get(a.slug) ?? 0) : 0) || a.sort_order - b.sort_order)
  if (options.length < 2 && !scope.slug) return null
  return (
    <div
      role="group"
      aria-label="League or brand"
      data-testid="panini-scope-bar"
      style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "12px 0 0" }}
    >
      <button type="button" aria-pressed={scope.slug === ""} onClick={() => scope.setSlug("")} style={chip(scope.slug === "")}>
        All{total != null ? ` · ${total.toLocaleString("en-US")}` : ""}
      </button>
      {options.map((p) => (
        <button key={p.slug} type="button" aria-pressed={scope.slug === p.slug} onClick={() => scope.setSlug(p.slug)} style={chip(scope.slug === p.slug)}>
          {p.name}{counts ? ` · ${(counts.get(p.slug) ?? 0).toLocaleString("en-US")}` : ""}
        </button>
      ))}
    </div>
  )
}
