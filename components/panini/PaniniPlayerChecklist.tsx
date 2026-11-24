"use client"

// components/panini/PaniniPlayerChecklist.tsx
//
// Panini player checklist (2026-11-23, Panini parity pass — Top Shot, All Day, Golazos, UFC, Candy and Pinnacle have
// player checklists; Panini had none). Every card the player page lists, owned vs missing for a PANINI USERNAME,
// and the cost to complete, from /api/entity/panini-player-checklist (get_panini_player_checklist).
//
// Username: the one the visitor last used on the Panini Collection tab or here (one shared localStorage slot,
// lib/panini/username-storage.ts). A Panini owner is a username, never a wallet.
//
// Honesty (lib/panini/player-checklist.ts):
//  - a failed read says so (status-checked fetch; a 404 = no cards hides the panel), never "0 owned";
//  - a username RPC has never seen reads "not seen", never "owns none"; a "seen" read is labelled a lower bound;
//  - the cost is split by SOURCE: live asks (within 3x FMV) + FMV where nothing is listed near it sum into the
//    headline; an ask on a card RPC hasn't priced is shown separately; unpriced cards are counted, never $0.
// No FMV confidence anywhere (internal only, 10-18). Brand tokens only.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import MomentMedia from "@/components/MomentMedia"
import { EM_DASH, fmtCount, fmtUsd } from "@/components/entity/_shared"
import { PANINI_USERNAME_STORAGE_KEY, normalizePaniniUsernameClient as normalizePaniniUsername } from "@/lib/panini/username-storage"
import { PANINI_FMV_SOURCE_NOTE } from "@/lib/panini/fmv-source-note"
import {
  fetchPaniniChecklist,
  paniniCardPriceLabel,
  paniniCostSummary,
  paniniOwnershipNote,
  type PaniniChecklistData,
  type PaniniChecklistLoad,
  type PaniniChecklistSubject,
} from "@/lib/panini/player-checklist"

const USERNAME_EVENT = "rpc-panini-username"
/**
 * Tiles rendered before "Show all". 24, not Pinnacle's 120 (2026-11-23 mobile read): at 390 px the tiles sit two to a
 * row, so 120 made a ~37,000 px panel on Lillard's page and pushed Editions, Bio and Recent Games a long scroll
 * down; a franchise hub panel holds up to 737 cards. "Missing only" and "Show all" reach the rest.
 */
export const PANINI_CHECKLIST_PAGE = 24

// Read through useSyncExternalStore: the server snapshot is null, so SSR and the first client render agree (no
// #418), and no setState runs inside an effect.
function subscribeUsername(cb: () => void): () => void {
  window.addEventListener("storage", cb)
  window.addEventListener(USERNAME_EVENT, cb)
  return () => {
    window.removeEventListener("storage", cb)
    window.removeEventListener(USERNAME_EVENT, cb)
  }
}
function readSavedUsername(): string | null {
  try {
    return normalizePaniniUsername(window.localStorage.getItem(PANINI_USERNAME_STORAGE_KEY) ?? "")
  } catch {
    return null
  }
}
function writeSavedUsername(v: string | null): void {
  try {
    if (v) window.localStorage.setItem(PANINI_USERNAME_STORAGE_KEY, v)
    else window.localStorage.removeItem(PANINI_USERNAME_STORAGE_KEY)
  } catch { /* localStorage unavailable */ }
  window.dispatchEvent(new Event(USERNAME_EVENT))
}

function ptDateTime(iso: string | null): string {
  if (!iso) return EM_DASH
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return EM_DASH
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/Los_Angeles" }) + " PT"
}

/**
 * `slug` + `player` = a player's checklist (Panini player pages). `franchise` = a franchise's (the Panini panel of a
 * /teams/<league>/<slug> hub, 2026-11-23 pass 2); `player` is then the franchise's display name and each tile names
 * its player.
 */
export default function PaniniPlayerChecklist({ slug, player, franchise }: { slug?: string; player: string; franchise?: { league: string; team: string } }) {
  const fLeague = franchise?.league ?? null
  const fTeam = franchise?.team ?? null
  const subject = useMemo<PaniniChecklistSubject>(
    () => (fLeague && fTeam ? { kind: "franchise", league: fLeague, team: fTeam } : { kind: "player", slug: slug ?? "" }),
    [fLeague, fTeam, slug],
  )
  const subjectKey = fLeague && fTeam ? `f:${fLeague}:${fTeam}` : `p:${slug ?? ""}`
  const username = useSyncExternalStore(subscribeUsername, readSavedUsername, () => null)
  const [draft, setDraft] = useState("")
  const [inputError, setInputError] = useState<string | null>(null)
  const [missingOnly, setMissingOnly] = useState(false)
  const [showAll, setShowAll] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Keyed by the request it answers: a result for another username/player/retry is "loading".
  const [result, setResult] = useState<{ key: string; r: PaniniChecklistLoad } | null>(null)

  const reqKey = `${subjectKey}|${username ?? ""}|${nonce}`
  useEffect(() => {
    let live = true
    void fetchPaniniChecklist(subject, username).then((r) => { if (live) setResult({ key: reqKey, r }) })
    return () => { live = false }
  }, [subject, username, reqKey])
  const state: { kind: "loading" } | PaniniChecklistLoad = result && result.key === reqKey ? result.r : { kind: "loading" }

  const onTrack = () => {
    const u = normalizePaniniUsername(draft)
    if (!u) {
      setInputError("That doesn't look like a Panini username (2–16 letters, numbers, . _ -).")
      return
    }
    setInputError(null)
    writeSavedUsername(u)
  }
  const onClear = () => {
    setDraft("")
    setMissingOnly(false)
    writeSavedUsername(null)
  }

  const data = state.kind === "ok" ? state.data : null
  const tracking = !!(data && data.username && data.username_seen)
  const cards = useMemo(() => {
    if (!data) return []
    return missingOnly && tracking ? data.cards.filter((c) => (c.owned_count ?? 0) === 0) : data.cards
  }, [data, missingOnly, tracking])

  if (state.kind === "none") return null

  const muted = { color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 } as const

  return (
    <div data-testid="panini-player-checklist">
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 10 }}>
        {username ? (
          <>
            <span style={muted}>Tracking Panini username <b style={{ color: "var(--rpc-text-primary)" }}>{username}</b></span>
            <button type="button" className="rpc-btn-ghost" onClick={onClear} style={{ fontSize: 12 }}>Clear</button>
          </>
        ) : (
          <>
            <label htmlFor="ppc-username" style={muted}>See which you own:</label>
            <input
              id="ppc-username"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") onTrack() }}
              placeholder="Panini username"
              autoComplete="off"
              spellCheck={false}
              style={{
                flex: "1 1 160px", minWidth: 0, maxWidth: 220, padding: "6px 8px",
                background: "var(--rpc-surface)", color: "var(--rpc-text-primary)",
                border: "1px solid var(--rpc-border)", borderRadius: 6, fontFamily: "var(--font-mono)", fontSize: 12,
              }}
            />
            <button type="button" className="rpc-btn-primary" onClick={onTrack} style={{ fontSize: 12 }}>Track</button>
          </>
        )}
        {tracking ? (
          <label style={{ ...muted, display: "inline-flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
            <input type="checkbox" checked={missingOnly} onChange={(e) => setMissingOnly(e.target.checked)} />
            Missing only
          </label>
        ) : null}
      </div>
      {inputError ? <div role="alert" style={{ ...muted, color: "var(--rpc-red-text)", marginBottom: 8 }}>{inputError}</div> : null}

      {state.kind === "loading" ? <div style={muted}>Loading {player}&apos;s Panini cards…</div> : null}
      {state.kind === "error" ? (
        <div style={muted}>
          The checklist couldn&apos;t load right now.{" "}
          <button type="button" className="rpc-btn-ghost" onClick={() => setNonce((n) => n + 1)} style={{ fontSize: 12 }}>Retry</button>
        </div>
      ) : null}

      {data ? <ChecklistHeader data={data} subjectName={player} /> : null}

      {data ? (
        <div style={{ display: "grid", gap: 8, marginTop: 10, gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
          {(showAll ? cards : cards.slice(0, PANINI_CHECKLIST_PAGE)).map((c) => {
            const owned = (c.owned_count ?? 0) > 0
            const dim = tracking && !owned
            return (
              <Link
                key={c.external_id}
                href={`/panini-blockchain/edition/${encodeURIComponent(c.external_id)}`}
                prefetch={false}
                className="rpc-card"
                style={{
                  display: "flex", flexDirection: "column", gap: 4, padding: 8, textDecoration: "none", color: "inherit",
                  border: owned && tracking ? "1px solid var(--rpc-success, var(--rpc-border))" : "1px solid var(--rpc-border)",
                  opacity: dim ? 0.72 : 1,
                }}
              >
                <div style={{ aspectRatio: "1 / 1", borderRadius: 6, overflow: "hidden", background: "var(--rpc-surface)" }}>
                  {c.thumbnail_url ? <MomentMedia thumbnailUrl={c.thumbnail_url} alt={`${c.player_name ?? player} — ${c.set_name ?? ""}`} size={140} rounded={6} /> : null}
                </div>
                {franchise && c.player_name ? <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.25 }}>{c.player_name}</div> : null}
                <div style={{ fontSize: 12, fontWeight: franchise ? 400 : 600, lineHeight: 1.25 }}>{c.set_name ?? c.parallel ?? EM_DASH}</div>
                <div style={{ ...muted, fontSize: 10, lineHeight: 1.3 }}>
                  {[c.product_name, c.mint_cap != null ? `/${fmtCount(c.mint_cap)}` : null].filter(Boolean).join(" · ") || EM_DASH}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 4, marginTop: "auto", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  <span>{paniniCardPriceLabel(c)}</span>
                  {tracking ? (
                    <span style={{ color: owned ? "var(--rpc-success, var(--rpc-text-primary))" : "var(--rpc-text-muted)" }}>
                      {owned ? `✓${(c.owned_count ?? 0) > 1 ? ` ×${c.owned_count}` : ""}` : "Missing"}
                    </span>
                  ) : null}
                </div>
              </Link>
            )
          })}
        </div>
      ) : null}
      {data && !showAll && cards.length > PANINI_CHECKLIST_PAGE ? (
        <button type="button" className="rpc-btn-ghost" onClick={() => setShowAll(true)} style={{ marginTop: 10, fontSize: 12 }}>
          Show all {fmtCount(cards.length)} cards
        </button>
      ) : null}
      {data ? <div style={{ ...muted, fontSize: 11, marginTop: 10, lineHeight: 1.5 }}>{PANINI_FMV_SOURCE_NOTE}</div> : null}
    </div>
  )
}

function ChecklistHeader({ data, subjectName }: { data: PaniniChecklistData; subjectName: string }) {
  const muted = { color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 } as const
  const { headline, parts } = paniniCostSummary(data)
  const tracking = !!(data.username && data.username_seen)

  if (data.username && data.username_seen === false) {
    return (
      <div style={muted}>
        {fmtCount(data.total)} cards. RPC hasn&apos;t seen a Panini card under <b>{data.username}</b> yet — check the spelling, or{" "}
        <Link href={`/panini-blockchain/collection?username=${encodeURIComponent(data.username)}`} rel="nofollow">open it in the Collection tab</Link>.
      </div>
    )
  }

  const complete = tracking && data.missing === 0
  const pct = tracking && data.total > 0 && data.owned != null ? Math.round((data.owned / data.total) * 1000) / 10 : null
  const note = paniniOwnershipNote(data, ptDateTime)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, letterSpacing: 0.5 }}>
        {tracking
          ? <>{fmtCount(data.owned)} of {fmtCount(data.total)} cards owned{pct != null ? ` · ${pct}%` : ""}</>
          : <>{fmtCount(data.total)} cards</>}
      </div>
      {complete ? (
        <div style={muted}>Complete — {data.username} holds every {subjectName} card RPC knows of.</div>
      ) : (
        <div style={muted}>
          {tracking ? "Cost to complete" : "Cost of every card"}:{" "}
          <strong style={{ color: "var(--rpc-text-primary)" }}>{headline != null ? `≈ ${fmtUsd(headline)}` : EM_DASH}</strong>
          {parts.length ? <> ({parts.join("; ")})</> : null}
        </div>
      )}
      {note ? <div style={{ ...muted, fontSize: 11 }}>{note}</div> : null}
    </div>
  )
}
