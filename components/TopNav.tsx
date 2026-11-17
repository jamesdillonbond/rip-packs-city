"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState, useSyncExternalStore } from "react"
import { getSupabaseBrowser } from "@/lib/auth/supabase-client"
import { getCollection, publishedCollections } from "@/lib/collections"
import { groupForPath, resolveHref, visibleGroups, visibleItems, DEFAULT_COLLECTION } from "@/lib/ia"
import { accentText } from "@/lib/accent-text"
import { readRecordedLastCollection, setLastCollection, subscribeLastCollection } from "@/lib/active-collection"

// ── IA Phase 2 (2026-11-06) ──────────────────────────────────────────────────
// The header is the "take me to the feature" nav: the six job groups from
// lib/ia.ts, each a link to its hub with a hover / focus menu of its pages.
// Collections are a SCOPE, not destinations — the seven per-collection links
// that used to live here are one switcher chip (the current collection, or the
// one last visited), and every collection-scoped item resolves against it.
// docs/strategy/features/information-architecture-2026-11-06.md
//
// Why no JS menu state: a CSS :hover / :focus-within menu is keyboard-reachable
// (Tab into the group link, then Tab through its items), needs no portal, and
// cannot be left open by a lost pointer. Every item is a real <a>.
//
// 2026-11-07: NOT an ARIA menu. The panels carried role="menu" / "menuitem" and
// the trigger aria-haspopup="menu" — a promise of the menu-widget keyboard
// contract (arrow keys move, Escape closes, Tab leaves the whole menu) that this
// component does not keep: Tab walks the items one by one and arrows do
// nothing, so a screen reader announced "menu, 10 items" and then behaved like
// a list of links. It IS a list of links (a disclosure), so it is marked up as
// one: a labelled group of plain anchors. axe never flagged the old markup —
// the structure was valid; the behaviour contract was the thing missing.

// The remembered collection is the SAME record MobileNav reads
// (lib/active-collection, `rpc_last_collection`) — one memory, two renderers.
// Read through useSyncExternalStore so the server render (no storage) and the
// first client render agree, with no set-state-in-effect.
const noRecord = () => null

export default function TopNav() {
  const pathname = usePathname() ?? "/"
  const [signedIn, setSignedIn] = useState(false)
  // The collection in the URL wins; otherwise the remembered one; otherwise Top Shot.
  const urlCollection = getCollection(pathname.split("/").filter(Boolean)[0] ?? "")?.id ?? null
  const recorded = useSyncExternalStore(subscribeLastCollection, readRecordedLastCollection, noRecord)
  const remembered = recorded && getCollection(recorded) ? recorded : null
  const collectionId = urlCollection ?? remembered ?? DEFAULT_COLLECTION

  // Visiting a collection page records it (the store notifies this render).
  useEffect(() => {
    if (urlCollection) setLastCollection(urlCollection)
  }, [urlCollection])

  useEffect(() => {
    let active = true
    const supabase = getSupabaseBrowser()
    supabase.auth.getUser().then(({ data }: { data: { user: unknown } | null }) => {
      if (active) setSignedIn(!!data?.user)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event: string, session: { user?: unknown } | null) => {
      if (active) setSignedIn(!!session?.user)
    })
    return () => {
      active = false
      sub?.subscription?.unsubscribe()
    }
  }, [])

  const activeGroup = groupForPath(pathname)
  const groups = visibleGroups(signedIn)
  const current = getCollection(collectionId) ?? getCollection(DEFAULT_COLLECTION)!

  return (
    // Width notes from 2026-10-03 still apply: the nav never shrinks and labels
    // never wrap; six one-word groups + one chip are narrower than the eleven
    // links this replaced, so the 768 px row has more room, not less.
    <nav className="hidden md:flex items-center shrink-0 md:gap-0 lg:gap-1 text-sm rpc-topnav" aria-label="Site">
      <style>{`
        .rpc-topnav-group { position: relative; }
        .rpc-topnav-menu { display: none; position: absolute; top: 100%; left: 0; min-width: 220px; padding: 6px; margin-top: 4px;
          background: var(--rpc-header-bg); border: 1px solid var(--rpc-border); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,0.45); z-index: 120; }
        .rpc-topnav-group:hover > .rpc-topnav-menu, .rpc-topnav-group:focus-within > .rpc-topnav-menu { display: block; }
        .rpc-topnav-menu a { display: block; padding: 7px 10px; border-radius: 6px; font-size: 13px; white-space: nowrap; text-decoration: none;
          color: var(--rpc-text-secondary); }
        .rpc-topnav-menu a:hover, .rpc-topnav-menu a:focus { color: var(--rpc-text-primary); background: var(--rpc-surface-hover); outline: none; }
        .rpc-topnav-job { display: block; padding: 4px 10px 8px; font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em;
          text-transform: uppercase; color: var(--rpc-text-muted); }
      `}</style>

      {/* Collection switcher chip — the scope every collection-scoped item resolves against. */}
      <div className="rpc-topnav-group">
        <Link
          href={`/${current.id}/overview`}
          aria-label={`Collection: ${current.shortLabel}. Switch collection`}
          data-tour-anchor="collection-switcher"
          className="rounded-full md:px-2 lg:px-3 py-1 mr-1 whitespace-nowrap font-semibold text-xs tracking-wide"
          style={{ border: `1px solid ${current.accent}`, background: `${current.accent}18`, color: accentText(current.accent) }}
        >
          {current.icon} {current.shortLabel} ▾
        </Link>
        <div className="rpc-topnav-menu" role="group" aria-label="Collections" data-ia-menu="collections">
          <span className="rpc-topnav-job">Collections</span>
          {publishedCollections().map((c) => (
            <Link key={c.id} href={`/${c.id}/overview`} data-ia-item prefetch={false} aria-current={c.id === current.id ? "true" : undefined}
              style={c.id === current.id ? { color: accentText(c.accent) } : undefined}>
              {c.icon} {c.shortLabel}
            </Link>
          ))}
        </div>
      </div>

      {groups.map((g) => {
        const active = activeGroup === g.id
        const items = visibleItems(g, signedIn)
        return (
          <div key={g.id} className="rpc-topnav-group">
            <Link
              href={resolveHref(g.href, collectionId, g.page)}
              aria-current={active ? "page" : undefined}
              data-ia-group={g.id}
              className={
                "block rounded-md md:px-1 lg:px-2.5 py-1.5 whitespace-nowrap transition-colors font-medium md:tracking-normal lg:tracking-wide " +
                (active
                  ? "text-[color:var(--rpc-text-primary)] bg-[color:var(--rpc-surface-hover)]"
                  : "text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)] hover:bg-[color:var(--rpc-surface-hover)]")
              }
            >
              {g.label}
            </Link>
            <div className="rpc-topnav-menu" role="group" aria-label={g.label} data-ia-menu={g.id}>
              <span className="rpc-topnav-job">{g.job}</span>
              {items.map((i) => (
                <Link key={i.href} href={resolveHref(i.href, collectionId, i.page)} data-ia-item
                  // ~40 menu links on every page: none is prefetched (2026-10-04 /analytics lesson, generalised).
                  prefetch={false}>
                  {i.label}
                </Link>
              ))}
            </div>
          </div>
        )
      })}
    </nav>
  )
}
