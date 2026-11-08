"use client"

// app/trophy-challenges/[slug]/ChallengeBoardClient.tsx
//
// ⚠ FOUR STATES, never collapsed (CLAUDE.md "Honesty"): loading · failed read
// (a retry notice — NEVER "no entries yet", which is a claim about the
// challenge) · unknown challenge (404) · loaded, where an empty entry list is
// genuinely "be the first".

import Link from "next/link"
import { useEffect, useState } from "react"
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab"
import { slotsOf } from "@/components/profile/TrophyCasesPanel"
import { challengeCaseSharePath, challengeEntryHref } from "@/lib/trophy/challenge-link"
import { trackFunnelEvent } from "@/lib/track-funnel"

const condensedFont = "var(--font-display)"
const monoFont = "var(--font-mono)"

interface Entry {
  case_id: string
  username: string
  slab_count: number
  completed_at: string | null
  slabs: TrophySlabData[]
}
interface Board {
  challenge: { slug: string; title: string; tagline: string | null; description: string | null; is_active: boolean; ends_at: string | null }
  entry_count: number
  entries: Entry[]
  /** Decided SERVER-side by the route (no wall-clock read on the client). */
  is_open?: boolean
}

type State = { kind: "loading" } | { kind: "failed" } | { kind: "missing" } | { kind: "ok"; board: Board }

/**
 * Who is looking (2026-11-08). THREE states: a signed-out visitor gets the
 * account-creation CTA; a signed-in one, or one whose session read FAILED,
 * keeps the dashboard link (which the auth gate bounces to /login with the
 * deep link intact, so "unknown" still works — it just reads less clearly).
 * /api/profile/me answers `{ user: null }` with a 200 when signed out.
 */
export type Viewer = "unknown" | "signed-in" | "signed-out"

export function viewerFromMe(res: { ok: boolean; json: unknown }): Viewer {
  if (!res.ok || !res.json || typeof res.json !== "object" || !("user" in res.json)) return "unknown"
  return (res.json as { user: unknown }).user ? "signed-in" : "signed-out"
}

/** Signed-out entry: create the account, then land on the challenge's spot on the dashboard. */
export function challengeSignupHref(slug: string): string {
  return `/login?intent=signup&next=${encodeURIComponent(challengeEntryHref(slug))}`
}

export function challengeSigninHref(slug: string): string {
  return `/login?next=${encodeURIComponent(challengeEntryHref(slug))}`
}

export default function ChallengeBoardClient({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [viewer, setViewer] = useState<Viewer>("unknown")

  // 2026-11-08 activity review: 8 of 15 outside visitors to /dame-time saw only
  // this page and left; 2 reached /login. Signed out, the one button said
  // "Enter from your dashboard" — a step that reads as "you need an account
  // already". A signed-out visitor now sees what entering takes.
  useEffect(() => {
    let cancelled = false
    fetch("/api/profile/me", { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, json: r.ok ? await r.json() : null }))
      .catch(() => ({ ok: false, json: null }))
      .then((res) => { if (!cancelled) setViewer(viewerFromMe(res)) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch("/api/public/trophy-challenges/" + encodeURIComponent(slug), { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 404) return { kind: "missing" } as State
        if (!r.ok) throw new Error(String(r.status))
        const d = (await r.json()) as Board
        if (!d?.challenge || !Array.isArray(d.entries)) throw new Error("bad body")
        return { kind: "ok", board: d } as State
      })
      .then((s) => { if (!cancelled) setState(s) })
      .catch(() => { if (!cancelled) setState({ kind: "failed" }) })
    return () => { cancelled = true }
  }, [slug])

  if (state.kind === "loading") {
    return <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>Loading challenge…</div>
  }
  if (state.kind === "failed") {
    return (
      <div role="status" style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>
        Couldn&rsquo;t load this challenge right now. Refresh to try again.
      </div>
    )
  }
  if (state.kind === "missing") {
    return (
      <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)" }}>
        There&rsquo;s no trophy challenge here. <Link href="/">Back home</Link>
      </div>
    )
  }

  const { challenge, entries, entry_count } = state.board
  const open = state.board.is_open === true

  return (
    <div>
      <style>{`
        @media (max-width: 768px) {
          .rpc-chal-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
      `}</style>
      <div style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
        Trophy case challenge
      </div>
      <h1 style={{ margin: "6px 0 8px", fontFamily: condensedFont, fontWeight: 900, fontSize: 40, letterSpacing: "0.02em", textTransform: "uppercase", lineHeight: 1 }}>
        {challenge.title}
      </h1>
      {challenge.tagline && (
        <p style={{ margin: "0 0 6px", fontSize: 16, color: "var(--rpc-text-primary)" }}>{challenge.tagline}</p>
      )}
      {challenge.description && (
        <p style={{ margin: "0 0 16px", fontFamily: monoFont, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)", maxWidth: 720 }}>
          {challenge.description}
        </p>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 28 }}>
        {open && viewer === "signed-out" ? (
          <>
            <Link
              href={challengeSignupHref(slug)}
              onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: "challenge_board_signup" })}
              style={{
                fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase",
                padding: "10px 16px", borderRadius: 8, textDecoration: "none",
                // brand-exception: white label on the red CTA button
                background: "var(--rpc-red-fill)", color: "#fff",
              }}
            >
              Create a free account to enter
            </Link>
            <Link
              href={challengeSigninHref(slug)}
              onClick={() => trackFunnelEvent({ eventType: "signin_click", surface: "challenge_board" })}
              style={{ fontFamily: monoFont, fontSize: 11, letterSpacing: "0.08em", color: "var(--rpc-text-secondary)" }}
            >
              Have an account? Sign in
            </Link>
          </>
        ) : open ? (
          <Link
            href={challengeEntryHref(slug)}
            style={{
              fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase",
              padding: "10px 16px", borderRadius: 8, textDecoration: "none",
              background: "var(--rpc-red-fill)", color: "#fff",
            }}
          >
            Enter from your dashboard
          </Link>
        ) : (
          <span style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>This challenge has closed.</span>
        )}
        <span style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.08em" }}>
          {entry_count} {entry_count === 1 ? "entry" : "entries"}
          {entries.length < entry_count ? ` · showing the top ${entries.length}` : ""}
        </span>
      </div>
      {open && viewer === "signed-out" && (
        <p data-rpc-challenge-howto style={{ margin: "-16px 0 28px", fontFamily: monoFont, fontSize: 11, lineHeight: 1.6, color: "var(--rpc-text-muted)", maxWidth: 720 }}>
          Free: sign in with your email (no password), add your Top Shot username or Dapper wallet (and Panini username, if you have one), then pin up to six pieces to your entry.
        </p>
      )}

      {entries.length === 0 ? (
        <div style={{ fontFamily: monoFont, fontSize: 12, color: "var(--rpc-text-muted)", padding: "24px 0" }}>
          No entries yet{open ? " — be the first." : "."}
        </div>
      ) : (
        entries.map((e) => (
          <section key={e.case_id} style={{ marginBottom: 32 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
              <Link
                href={"/profile/" + encodeURIComponent(e.username)}
                style={{ fontFamily: condensedFont, fontWeight: 800, fontSize: 20, letterSpacing: "0.04em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}
              >
                @{e.username}
              </Link>
              <span style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.15em", color: "var(--rpc-text-muted)" }}>
                {/* `completed_at` is stamped once and never cleared, so "complete"
                    beside a live 4 / 6 contradicted itself (2026-11-07 review):
                    the live count decides. */}
                {e.slab_count} / 6{e.slab_count >= 6 ? " · complete" : ""}
              </span>
              {/* This entry's own share page (and card) — the handle above still
                  goes to the whole profile. */}
              <Link
                href={challengeCaseSharePath(e.username, slug)}
                style={{ fontFamily: monoFont, fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}
              >
                Open · share →
              </Link>
            </div>
            <div className="rpc-chal-grid" style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 16 }}>
              {slotsOf(e.slabs ?? []).map((s, i) => (
                <TrophySlab key={e.case_id + "-" + i} slab={s} slot={i + 1} mode="public" />
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  )
}
