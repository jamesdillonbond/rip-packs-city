"use client"

// components/entity/PlayerFollowButton.tsx
//
// Follow a player (2026-10-31; webz_80's 10-27 request, feedback 11800). The player
// pages are anon/ISR, so follow state is read on mount from /api/players/follow
// (RLS-enforced session client). Four honest states, as on TeamFollowButton:
// loading, signed out (a sign-in link), unknown (the read FAILED — never shown as
// "not following"), and following / not following. Followed players are listed on
// /my-teams.

import { useEffect, useState } from "react"

interface Props {
  /** the player's URL slug */
  slug: string
  /** set on a collection's player page: lets a player the cross-collection hub does not
   *  cover (Disney Pinnacle characters) be followed on that page (2026-10-31) */
  collection?: string
  /** page path for the sign-in `next` param */
  path: string
  name: string
}

type State = "loading" | "anon" | "following" | "not-following" | "unknown"

export default function PlayerFollowButton({ slug, collection, path, name }: Props) {
  const qs = new URLSearchParams(collection ? { slug, collection } : { slug }).toString()
  const [state, setState] = useState<State>("loading")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/players/follow?${qs}`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) { if (!cancelled) setState("unknown"); return }
        const j = (await r.json()) as { authed?: unknown; following?: unknown }
        if (cancelled) return
        if (typeof j?.authed !== "boolean") { setState("unknown"); return }
        setState(!j.authed ? "anon" : j.following === true ? "following" : "not-following")
      })
      .catch(() => { if (!cancelled) setState("unknown") })
    return () => { cancelled = true }
  }, [qs])

  async function setFollow(on: boolean) {
    if (busy) return
    setBusy(true)
    setMessage(null)
    let ok = false
    try {
      const res = on
        ? await fetch("/api/players/follow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(collection ? { slug, collection } : { slug }) })
        : await fetch(`/api/players/follow?${qs}`, { method: "DELETE" })
      if (res.status === 401) { ok = true; setState("anon"); return }
      if (res.status === 409) {
        setMessage("Follow limit reached")
        ok = true
        return
      }
      if (!res.ok) return
      ok = true
      setState(on ? "following" : "not-following")
    } catch {
      /* the failed message below says so */
    } finally {
      setBusy(false)
      if (!ok) setMessage("Couldn’t update — try again")
      if (!ok) setTimeout(() => setMessage(null), 4000)
    }
  }

  const base: React.CSSProperties = {
    display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 6,
    fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em", cursor: "pointer", textDecoration: "none",
    border: "1px solid var(--rpc-border)", color: "var(--rpc-text-primary)", background: "transparent",
  }

  if (state === "loading") return <span data-rpc-player-follow="loading" style={{ ...base, cursor: "default", color: "var(--rpc-text-muted)" }}>★ …</span>
  if (state === "unknown") {
    return (
      <span data-rpc-player-follow="unknown" title="Follow status couldn't be loaded — refresh to try again" style={{ ...base, cursor: "default", color: "var(--rpc-text-muted)" }}>
        ★ Follow unavailable
      </span>
    )
  }
  if (state === "anon") {
    return (
      <a data-rpc-player-follow="anon" href={`/login?next=${encodeURIComponent(path)}`} className="rpc-tap44" style={base}>
        ★ Sign in to follow
      </a>
    )
  }
  const following = state === "following"
  return (
    <button
      type="button"
      data-rpc-player-follow={following ? "following" : "not-following"}
      className="rpc-tap44"
      disabled={busy}
      aria-pressed={following}
      onClick={() => setFollow(!following)}
      title={following ? `Stop following ${name}` : `Follow ${name} — listed on My Teams`}
      style={{
        ...base,
        color: following ? "var(--rpc-red-text)" : "var(--rpc-text-primary)",
        background: following ? "var(--rpc-red-bg)" : "transparent",
        border: `1px solid ${following ? "var(--rpc-red-border)" : "var(--rpc-border)"}`,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {message ?? (following ? "★ Following" : "☆ Follow player")}
    </button>
  )
}
