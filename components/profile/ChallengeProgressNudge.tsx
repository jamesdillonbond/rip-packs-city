"use client"

// components/profile/ChallengeProgressNudge.tsx
//
// Dashboard Overview card for an UNFINISHED trophy-challenge entry (2026-11-08).
// A challenge is complete only with all 6 slots pinned (Trevor, 11-08). Two
// entrants sat at 2 / 6 and 4 / 6, and the only place their progress showed was
// the Trophy tab's "More Trophy Cases" panel, below the main case — the
// dashboard opens on Overview.
//
// Renders NOTHING unless /api/profile/trophy-cases answered ok AND lists an
// entry below 6 in a challenge the same answer lists as open. A failed read, an
// unknown challenge list (`challenges: null`) or a complete entry render nothing:
// "pin 2 more" is a claim about the collector's own case.

import { useEffect, useState } from "react"
import { challengeEntryHref, challengeShopHref } from "@/lib/trophy/challenge-link"
import { track } from "@/lib/telemetry/track"
import ChallengeCountdown from "@/components/profile/ChallengeCountdown"

/** Where a collector links the Panini username that lets their cards be pinned. */
export const PANINI_LINK_HREF = "/dashboard?tab=overview#panini-username"

export const CHALLENGE_SLOTS = 6

export interface UnfinishedEntry {
  slug: string
  title: string
  pinned: number
  /** The one-player challenge's hub, where more pieces are found; null otherwise. */
  shopHref: string | null
  endsAt: string | null
}

export interface UnenteredChallenge {
  slug: string
  title: string
  endsAt: string | null
}

/**
 * Open challenges the collector has NOT entered (2026-11-08). hatedjay filled his
 * MAIN case with six Dames and shared it — and never entered Dame Time; two more
 * entrants did the same before the copy step existed. Only from one ok answer
 * that lists both arrays; anything else is "unknown" and renders nothing.
 */
export function unenteredChallenges(body: unknown): UnenteredChallenge[] {
  if (!body || typeof body !== "object") return []
  const b = body as { cases?: unknown; challenges?: unknown }
  if (!Array.isArray(b.cases) || !Array.isArray(b.challenges)) return []
  const entered = new Set(
    (b.cases as { challenge?: { slug?: unknown } | null }[])
      .map((c) => (typeof c?.challenge?.slug === "string" ? c.challenge.slug : null))
      .filter((s): s is string => s != null),
  )
  const out: UnenteredChallenge[] = []
  for (const c of b.challenges as { slug?: unknown; title?: unknown; ends_at?: unknown }[]) {
    if (typeof c?.slug !== "string" || entered.has(c.slug)) continue
    out.push({ slug: c.slug, title: typeof c.title === "string" ? c.title : c.slug, endsAt: typeof c.ends_at === "string" ? c.ends_at : null })
  }
  return out
}

/** The open-challenge entries below 6 pinned, from one /api/profile/trophy-cases answer. */
export function unfinishedEntries(body: unknown): UnfinishedEntry[] {
  if (!body || typeof body !== "object") return []
  const b = body as { cases?: unknown; challenges?: unknown }
  if (!Array.isArray(b.cases) || !Array.isArray(b.challenges)) return []
  const open = new Set(
    (b.challenges as { slug?: unknown }[]).map((c) => (typeof c?.slug === "string" ? c.slug : null)).filter((s): s is string => s != null),
  )
  const endsBySlug = new Map(
    (b.challenges as { slug?: unknown; ends_at?: unknown }[])
      .filter((c) => typeof c?.slug === "string")
      .map((c) => [c.slug as string, typeof c.ends_at === "string" ? c.ends_at : null] as const),
  )
  const out: UnfinishedEntry[] = []
  for (const c of b.cases as { slabs?: unknown; challenge?: { slug?: unknown; title?: unknown; rules?: unknown } | null }[]) {
    const slug = typeof c?.challenge?.slug === "string" ? c.challenge.slug : null
    if (!slug || !open.has(slug)) continue
    const pinned = Array.isArray(c.slabs) ? c.slabs.length : null
    if (pinned == null || pinned >= CHALLENGE_SLOTS) continue
    out.push({
      slug,
      title: typeof c.challenge?.title === "string" ? c.challenge.title : slug,
      pinned,
      shopHref: challengeShopHref(c.challenge?.rules),
      endsAt: endsBySlug.get(slug) ?? null,
    })
  }
  return out
}

export default function ChallengeProgressNudge() {
  const [entries, setEntries] = useState<UnfinishedEntry[]>([])
  const [unentered, setUnentered] = useState<UnenteredChallenge[]>([])

  useEffect(() => {
    let active = true
    fetch("/api/profile/trophy-cases", { cache: "no-store" })
      .then(async (r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((body) => {
        if (!active) return
        const list = unfinishedEntries(body)
        setEntries(list)
        if (list.length) track("challenge-nudge-shown", { challenges: list.map((e) => e.slug).join(",") })
        const fresh = unenteredChallenges(body)
        setUnentered(fresh)
        if (fresh.length) track("challenge-invite-shown", { challenges: fresh.map((e) => e.slug).join(",") })
      })
    return () => {
      active = false
    }
  }, [])

  if (entries.length === 0 && unentered.length === 0) return null
  return (
    <>
      {unentered.map((c) => (
        <section
          key={`invite-${c.slug}`}
          className="rpc-card"
          data-rpc-challenge-invite
          style={{ padding: "16px 20px", border: "1px solid var(--rpc-red-border)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 260px" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
              {c.title}: you haven&rsquo;t entered yet
            </span>
            <ChallengeCountdown endsAt={c.endsAt} compact />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
              Your main trophy case doesn&rsquo;t count — the challenge has its own case. Tap Enter, pick 6, done.{" "}
              Panini cards count too:{" "}
              <a href={PANINI_LINK_HREF} style={{ color: "var(--rpc-red-text)", textDecoration: "none" }}>
                add your Panini username
              </a>{" "}
              first.
            </span>
          </div>
          <a
            href={challengeEntryHref(c.slug)}
            onClick={() => track("challenge-invite-click", { challenge: c.slug })}
            // brand-exception: white label on the red CTA button — theme-independent
            style={{ padding: "12px 20px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}
          >
            Enter {c.title} →
          </a>
        </section>
      ))}
      {entries.map((e) => (
        <section
          key={e.slug}
          className="rpc-card"
          data-rpc-challenge-nudge
          style={{ padding: "16px 20px", border: "1px solid var(--rpc-red-border)", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0, flex: "1 1 260px" }}>
            <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-lg)", letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
              {e.title}: {e.pinned} / {CHALLENGE_SLOTS}
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--rpc-text-secondary)", lineHeight: 1.5 }}>
              Pin {CHALLENGE_SLOTS - e.pinned} more to complete your entry.{" "}
              <ChallengeCountdown endsAt={e.endsAt} compact />
              {e.shopHref && (
                <>
                  {" "}
                  <a
                    href={e.shopHref}
                    data-rpc-challenge-shop
                    onClick={() => track("challenge-nudge-shop-click", { challenge: e.slug })}
                    style={{ color: "var(--rpc-red-text)", textDecoration: "none" }}
                  >
                    Find more pieces →
                  </a>
                </>
              )}
            </span>
          </div>
          {/* A full navigation, not <Link>: the dashboard captures `?challenge=` ONCE at
              mount (DashboardClient focusChallenge), so a soft nav to the same page
              would switch tabs without scrolling to the entry. */}
          <a
            href={challengeEntryHref(e.slug)}
            onClick={() => track("challenge-nudge-click", { challenge: e.slug })}
            // brand-exception: white label on the red CTA button — theme-independent
            style={{ padding: "12px 20px", background: "var(--rpc-red-fill)", borderRadius: 8, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}
          >
            Finish your case →
          </a>
        </section>
      ))}
    </>
  )
}
