"use client"

// components/entity/TeamFollowButton.tsx
// Team Hub Phase 4 (F1). Client island in the team hero. Favorites are
// one-per-league, so this is "set this as my <league> team" (replace), labeled
// explicitly so the per-league replace is honest. The team page is anon/ISR, so
// follow state can't be server-rendered per-user — we fetch it on mount.
//
// All writes go through /api/teams/follow, which runs as the authenticated user
// (RLS-enforced session client). Anonymous users get a sign-in link instead.

import { useEffect, useState } from "react"

interface Props {
  league: string          // NBA | WNBA | NFL | LALIGA | MLB
  teamShortSlug: string   // teams_master.slug, e.g. "lakers"
  teamPath: string        // /<collection>/team/<slug> — for the sign-in next param
  dark?: boolean          // true on the branded gradient (light text)
}

// "unknown": the status read FAILED. The route answers an anonymous visitor
// with 200 { authed:false }, so a non-ok or thrown read is not "signed out" —
// until 2026-09-26 it rendered "Sign in to follow" to a signed-in follower.
type State = "loading" | "anon" | "following" | "not-following" | "unknown"

export default function TeamFollowButton({ league, teamShortSlug, teamPath, dark }: Props) {
  const [state, setState] = useState<State>("loading")
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const p = new URLSearchParams({ league, slug: teamShortSlug })
    fetch(`/api/teams/follow?${p.toString()}`, { cache: "no-store" })
      .then(async r => {
        if (!r.ok) { if (!cancelled) setState("unknown"); return }
        const j = (await r.json()) as { authed?: unknown; following?: unknown }
        if (cancelled) return
        if (typeof j?.authed !== "boolean") { setState("unknown"); return }
        setState(!j.authed ? "anon" : j.following === true ? "following" : "not-following")
      })
      .catch(() => { if (!cancelled) setState("unknown") })
    return () => { cancelled = true }
  }, [league, teamShortSlug])

  async function setFollow(on: boolean) {
    if (busy) return
    setBusy(true)
    try {
      const res = on
        ? await fetch("/api/teams/follow", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ league, team_slug: teamShortSlug }),
          })
        : await fetch(`/api/teams/follow?${new URLSearchParams({ league, slug: teamShortSlug }).toString()}`, { method: "DELETE" })
      if (res.status === 401) { setState("anon"); return }
      if (!res.ok) return
      setState(on ? "following" : "not-following")
    } catch {
      /* leave state unchanged on error */
    } finally {
      setBusy(false)
    }
  }

  const baseStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 12px",
    borderRadius: 6,
    fontFamily: "var(--font-mono)",
    fontSize: 11,
    letterSpacing: "0.06em",
    cursor: "pointer",
    textDecoration: "none",
  }

  if (state === "loading") {
    return <span style={{ ...baseStyle, opacity: 0.5, color: dark ? "#fff" : "var(--rpc-text-muted)", border: `1px solid ${dark ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.14)"}` }}>★ …</span>
  }

  if (state === "unknown") {
    return (
      <span data-testid="follow-status-unknown" title="Follow status couldn't be loaded — refresh to try again" style={{ ...baseStyle, cursor: "default", opacity: 0.6, color: dark ? "#fff" : "var(--rpc-text-muted)", border: `1px solid ${dark ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.14)"}` }}>
        ★ Follow unavailable
      </span>
    )
  }

  if (state === "anon") {
    return (
      <a
        href={`/login?next=${encodeURIComponent(teamPath)}`}
        style={{ ...baseStyle, color: dark ? "#fff" : "var(--rpc-text-primary)", background: dark ? "rgba(0,0,0,0.30)" : "transparent", border: `1px solid ${dark ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.16)"}` }}
      >
        ★ Sign in to follow
      </a>
    )
  }

  const following = state === "following"
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => setFollow(!following)}
      style={{
        ...baseStyle,
        color: following ? (dark ? "#fff" : "var(--rpc-red)") : (dark ? "#fff" : "var(--rpc-text-primary)"),
        background: following ? (dark ? "rgba(255,255,255,0.18)" : "var(--rpc-red-bg)") : (dark ? "rgba(0,0,0,0.30)" : "transparent"),
        border: `1px solid ${following ? (dark ? "rgba(255,255,255,0.55)" : "var(--rpc-red-border)") : (dark ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.16)")}`,
        opacity: busy ? 0.6 : 1,
      }}
      title={following ? `Remove as your ${league} team` : `Set as your ${league} team (replaces any current ${league} pick)`}
    >
      {following ? `★ Your ${league} team` : `☆ Set as my ${league} team`}
    </button>
  )
}
