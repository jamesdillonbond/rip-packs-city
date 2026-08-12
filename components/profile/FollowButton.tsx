"use client";

// components/profile/FollowButton.tsx
//
// The missing entry point for the follows system. The backend has been
// complete since Phase 4 — `follows` table, full CRUD at
// /api/profile/follows, and a friend activity feed already rendered on
// /dashboard — but NOTHING in the product ever called it: a repo-wide grep
// for the route returned only the route itself, so `follows` sat at 0 rows
// and the dashboard permanently showed its "Follow other collectors to see
// their sales here" empty state with no way to follow anyone. This button is
// that way. (2026-08-11)
//
// The public profile page is ISR (revalidate 300), so follow state cannot be
// server-rendered per viewer — we probe on mount via
// GET /api/profile/follows?username=<u>, which answers { authed, following,
// self } and returns authed:false rather than 401 for anon. Same shape and
// same reasoning as components/entity/TeamFollowButton.tsx; keep them
// consistent if either changes.
//
// Renders nothing at all when the viewer is looking at their own profile —
// `self` comes from the server (auth id vs profile_bio.user_id), which is
// authoritative, rather than from a client-side username string compare.

import { useEffect, useState } from "react";

interface Props {
  /** profile_bio.username of the profile being viewed. */
  username: string;
  /** Profile accent colour, already resolved by the caller. Literal hex. */
  accentColor: string;
}

type State = "loading" | "anon" | "self" | "following" | "not-following";

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 14px",
  borderRadius: 6,
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.12em",
  textDecoration: "none",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export default function FollowButton({ username, accentColor }: Props) {
  const [state, setState] = useState<State>("loading");
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);

  useEffect(() => {
    if (!username) return;
    let cancelled = false;

    fetch("/api/profile/follows?username=" + encodeURIComponent(username), {
      cache: "no-store",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        // A failed probe must not render as "not following" — that would show
        // a Follow button whose click then 500s. Fall back to the sign-in CTA,
        // which is inert and honest.
        if (!j) { setState("anon"); return; }
        if (!j.authed) { setState("anon"); return; }
        if (j.self) { setState("self"); return; }
        setState(j.following ? "following" : "not-following");
      })
      .catch(() => { if (!cancelled) setState("anon"); });

    return () => { cancelled = true; };
  }, [username]);

  async function setFollow(on: boolean) {
    if (busy) return;
    setBusy(true);
    // Optimistic, with rollback — the write is a single row and the button is
    // the only thing that reflects it, so a snap-back on failure is honest.
    const previous: State = on ? "not-following" : "following";
    setState(on ? "following" : "not-following");
    try {
      const res = await fetch("/api/profile/follows", {
        method: on ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      if (res.status === 401) { setState("anon"); return; }
      if (!res.ok) { setState(previous); return; }
    } catch {
      setState(previous);
    } finally {
      setBusy(false);
    }
  }

  if (state === "self") return null;

  if (state === "loading") {
    return (
      <span
        aria-hidden="true"
        style={{
          ...baseStyle,
          opacity: 0.4,
          color: "var(--rpc-text-muted)",
          border: "1px solid rgba(255,255,255,0.14)",
          cursor: "default",
        }}
      >
        ···
      </span>
    );
  }

  if (state === "anon") {
    return (
      <a
        href={"/login?next=" + encodeURIComponent("/profile/" + username)}
        style={{
          ...baseStyle,
          color: "var(--rpc-text-primary)",
          border: "1px solid rgba(255,255,255,0.16)",
        }}
      >
        + SIGN IN TO FOLLOW
      </a>
    );
  }

  const following = state === "following";

  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => setFollow(!following)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-pressed={following}
      title={following ? "Unfollow @" + username : "Follow @" + username + " — their sales show up on your dashboard"}
      style={{
        ...baseStyle,
        color: following ? accentColor : "var(--rpc-text-primary)",
        background: following ? "rgba(255,255,255,0.04)" : "transparent",
        border: "1px solid " + (following ? accentColor : "rgba(255,255,255,0.16)"),
        opacity: busy ? 0.6 : 1,
      }}
    >
      {following ? (hover ? "✕ UNFOLLOW" : "✓ FOLLOWING") : "+ FOLLOW"}
    </button>
  );
}
