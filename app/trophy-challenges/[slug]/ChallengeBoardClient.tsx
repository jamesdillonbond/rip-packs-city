"use client"

// app/trophy-challenges/[slug]/ChallengeBoardClient.tsx
//
// ⚠ FOUR STATES, never collapsed (CLAUDE.md "Honesty"): loading · failed read
// (a retry notice — NEVER "no entries yet", which is a claim about the
// challenge) · unknown challenge (404) · loaded, where an empty entry list is
// genuinely "be the first".

import ChallengeCountdown from "@/components/profile/ChallengeCountdown"
import Link from "next/link"
import { useEffect, useState } from "react"
import TrophySlab, { type TrophySlabData } from "@/components/TrophySlab"
import { slotsOf } from "@/components/profile/TrophyCasesPanel"
import { challengeCaseSharePath, challengeEntryHref, challengeShopHref } from "@/lib/trophy/challenge-link"
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
  challenge: { slug: string; title: string; tagline: string | null; description: string | null; is_active: boolean; ends_at: string | null; rules?: unknown }
  entry_count: number
  entries: Entry[]
  /** Decided SERVER-side by the route (no wall-clock read on the client). */
  is_open?: boolean
  /** The open giveaway drop whose packs are for this challenge's finishers (null: none taking claims, or the read failed). */
  reward?: { slug: string; title: string } | null
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

/** The viewer's public handle (profile_bio.username — the same key the board's entries carry), or null. */
export function viewerHandleFromMe(res: { ok: boolean; json: unknown }): string | null {
  if (viewerFromMe(res) !== "signed-in") return null
  const u = (res.json as { user?: { username?: unknown } }).user?.username
  return typeof u === "string" && u.trim() ? u.trim() : null
}

/**
 * The viewer's own entry on this board (2026-11-08). THREE answers: their entry ·
 * "none" (the board is complete — every entry is listed — and theirs is not on it) ·
 * null (no handle, or the board lists only the top N, so absence proves nothing).
 */
export function ownEntryOf<E extends { username: string }>(
  handle: string | null,
  entries: E[],
  entryCount: number,
): E | "none" | null {
  if (!handle) return null
  const mine = entries.find((e) => e.username.toLowerCase() === handle.toLowerCase())
  if (mine) return mine
  return entries.length >= entryCount ? "none" : null
}

/** Signed-out entry: create the account, then land on the challenge's spot on the dashboard. */
export function challengeSignupHref(slug: string): string {
  return `/login?intent=signup&next=${encodeURIComponent(challengeEntryHref(slug))}`
}

export function challengeSigninHref(slug: string): string {
  return `/login?next=${encodeURIComponent(challengeEntryHref(slug))}`
}

/** Where a CLOSED board sends its viewer (2026-11-10): a completed entrant to
 *  their case; anyone signed in to their own trophy case; signed out to sign-up
 *  with the trophy tab as the return path. */
export function closedChallengeHref(
  viewer: "signed-in" | "signed-out" | "unknown",
  own: { username: string; complete: boolean } | null,
  slug: string,
): string {
  if (viewer === "signed-in" && own?.complete) return challengeCaseSharePath(own.username, slug)
  if (viewer === "signed-in") return "/dashboard?tab=trophy"
  return `/login?intent=signup&next=${encodeURIComponent("/dashboard?tab=trophy")}`
}

/** What the reward-pack banner says and where it goes (2026-11-10). A finisher is told
 *  the pack is theirs; a signed-out visitor is sent through sign-in and back to the packs;
 *  anyone else is told who the packs are for (the claim page says the same and refuses
 *  an account without a completed entry). */
export function rewardBanner(
  viewer: "signed-in" | "signed-out" | "unknown",
  ownComplete: boolean,
  challengeTitle: string,
  reward: { slug: string; title: string },
): { text: string; label: string; href: string } {
  const packs = `/giveaways/${reward.slug}`
  if (viewer === "signed-in" && ownComplete) return { text: `You completed ${challengeTitle}. Your reward pack is ready.`, label: "Claim your pack", href: packs }
  if (viewer === "signed-out") {
    return { text: `Reward packs are out for everyone who completed ${challengeTitle}.`, label: "Sign in to claim yours", href: `/login?next=${encodeURIComponent(packs)}` }
  }
  return { text: `Reward packs are out for everyone who completed ${challengeTitle}.`, label: "See the reward packs", href: packs }
}

export function closedChallengeLabel(viewer: "signed-in" | "signed-out" | "unknown", complete: boolean): string {
  if (viewer === "signed-in" && complete) return "See your case"
  if (viewer === "signed-in") return "Build your trophy case"
  return "Create a free account"
}

export default function ChallengeBoardClient({ slug }: { slug: string }) {
  const [state, setState] = useState<State>({ kind: "loading" })
  const [viewer, setViewer] = useState<Viewer>("unknown")
  const [viewerHandle, setViewerHandle] = useState<string | null>(null)

  // 2026-11-08 activity review: 8 of 15 outside visitors to /dame-time saw only
  // this page and left; 2 reached /login. Signed out, the one button said
  // "Enter from your dashboard" — a step that reads as "you need an account
  // already". A signed-out visitor now sees what entering takes.
  useEffect(() => {
    let cancelled = false
    fetch("/api/profile/me", { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, json: r.ok ? await r.json() : null }))
      .catch(() => ({ ok: false, json: null }))
      .then((res) => {
        if (cancelled) return
        setViewer(viewerFromMe(res))
        setViewerHandle(viewerHandleFromMe(res))
      })
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
  // A signed-in collector who has ENTERED sees their own progress, not "Enter".
  // 11-08: two entrants sat at 2 / 6 and 4 / 6 with nothing on the board telling
  // them what finishing takes. A challenge is complete at all 6 (Trevor, 11-08).
  const own = viewer === "signed-in" ? ownEntryOf(viewerHandle, entries, entry_count) : null
  const ownEntry = own && own !== "none" ? own : null

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
      {open && <ChallengeCountdown endsAt={challenge.ends_at} />}
      {/* 2026-11-08: three collectors filled their MAIN case with Dames and never
          entered; another asked how to show Panini cards. Say both plainly. */}
      {open && (
        <p data-rpc-challenge-howto style={{ margin: "0 0 12px", fontFamily: monoFont, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-secondary)", maxWidth: 720 }}>
          How to enter: on your dashboard, tap <strong>Enter</strong> on {challenge.title} and pick 6 — your main trophy case doesn&rsquo;t count on its own.
          Panini cards count too: <Link href="/dashboard?tab=overview#panini-username" style={{ color: "var(--rpc-red-text)", textDecoration: "none" }}>add your Panini username</Link> first, then they show up in the picker.
        </p>
      )}
      {challenge.description && (
        <p style={{ margin: "0 0 16px", fontFamily: monoFont, fontSize: 12, lineHeight: 1.6, color: "var(--rpc-text-muted)", maxWidth: 720 }}>
          {challenge.description}
        </p>
      )}
      {state.board.reward ? (() => {
        const b = rewardBanner(viewer, ownEntry ? ownEntry.slab_count >= 6 : false, challenge.title, state.board.reward)
        return (
          <div
            data-rpc-challenge-reward
            style={{
              display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "0 0 18px", padding: "12px 14px",
              border: "1px solid var(--rpc-red-border)", borderRadius: 10, background: "var(--rpc-red-bg)",
            }}
          >
            <span style={{ fontSize: 14, color: "var(--rpc-text-primary)", flex: "1 1 220px" }}>{b.text}</span>
            <Link
              href={b.href}
              style={{
                fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase",
                padding: "10px 16px", borderRadius: 8, textDecoration: "none",
                // brand-exception: white label on the red CTA button
                background: "var(--rpc-red-fill)", color: "#fff",
              }}
            >
              {b.label}
            </Link>
          </div>
        )
      })() : null}
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
        ) : open && ownEntry ? (
          <span data-rpc-own-entry style={{ display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: monoFont, fontSize: 11, letterSpacing: "0.08em", color: "var(--rpc-text-primary)" }}>
              Your entry: {ownEntry.slab_count} / 6{ownEntry.slab_count >= 6 ? " · complete" : ` · pin ${6 - ownEntry.slab_count} more to complete`}
            </span>
            <Link
              href={ownEntry.slab_count >= 6 ? challengeCaseSharePath(ownEntry.username, slug) : challengeEntryHref(slug)}
              style={{
                fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase",
                padding: "10px 16px", borderRadius: 8, textDecoration: "none",
                // brand-exception: white label on the red CTA button
                background: "var(--rpc-red-fill)", color: "#fff",
              }}
            >
              {ownEntry.slab_count >= 6 ? "Share your case" : "Finish your case"}
            </Link>
            {ownEntry.slab_count < 6 && challengeShopHref(challenge.rules) && (
              <Link
                href={challengeShopHref(challenge.rules)!}
                data-rpc-challenge-shop
                style={{ fontFamily: monoFont, fontSize: 11, letterSpacing: "0.08em", color: "var(--rpc-text-secondary)" }}
              >
                Find more pieces →
              </Link>
            )}
          </span>
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
          // 2026-11-10: a closed board was a dead end. Dame Time locked 11-10
          // while its X post kept sending people here; one signed up from it and
          // left 14 s later with nothing to do. Closed now says so AND offers the
          // next step: a finished entrant shares their case, anyone else builds
          // their own trophy case (signed out: creates the account first).
          <span data-rpc-challenge-closed style={{ display: "inline-flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)" }}>This challenge has closed.</span>
            <Link
              href={closedChallengeHref(viewer, ownEntry ? { username: ownEntry.username, complete: ownEntry.slab_count >= 6 } : null, slug)}
              onClick={viewer === "signed-out" ? () => trackFunnelEvent({ eventType: "signin_click", surface: "challenge_closed_signup" }) : undefined}
              style={{
                fontFamily: condensedFont, fontWeight: 800, fontSize: 13, letterSpacing: "0.08em", textTransform: "uppercase",
                padding: "10px 16px", borderRadius: 8, textDecoration: "none",
                // brand-exception: white label on the red CTA button
                background: "var(--rpc-red-fill)", color: "#fff",
              }}
            >
              {closedChallengeLabel(viewer, ownEntry ? ownEntry.slab_count >= 6 : false)}
            </Link>
          </span>
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
