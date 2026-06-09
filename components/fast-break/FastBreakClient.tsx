"use client"
// components/fast-break/FastBreakClient.tsx
//
// The interactive heart of /[collection]/fast-break: hero lineup card,
// missing-players list, run-progress widget, save flow. Reads from
// /api/fast-break/optimize (60s warmCache) and /api/fast-break/uses (no
// TTL — refetched after every successful save). Save flow honors the
// idempotent flag the route returns and surfaces "Already saved" instead
// of "Saved!" when a re-save changes nothing.

import { useCallback, useMemo, useState } from "react"
import { useWarmCache } from "@/lib/warmup/WarmupContext"

type Tier = "COMMON" | "FANDOM" | "RARE" | "LEGENDARY" | "ULTIMATE"

interface OptimizePlayer {
  nbaPlayerId: string
  fullName: string
  teamAbbr: string
  highestTier: Tier
  remainingUses: number
  bestMomentId: string
  bestSerial: number
  projPoints: number
  projMinutes: number
  injuryStatus: string | null
  gameId: string
  opponentTeamAbbr: string
}

interface OptimizeLineup {
  players: OptimizePlayer[]
  captainNbaPlayerId: string | null
  projectedScore: number
  serialSum: number
}

interface MissingPlayer {
  nbaPlayerId: string
  fullName: string | null
  teamAbbr: string | null
  projFp: number | null
  cheapestListing: { momentId: string | null; askUsd: number; url: string | null } | null
}

interface OptimizeResponse {
  walletAddr: string
  runId: string
  gameDate: string
  lineupSize: number
  eligibleCount: number
  consideredCount: number
  lineup: OptimizeLineup | null
  alternates: OptimizeLineup[]
  missingPlayers: MissingPlayer[]
  message?: string
}

interface UseRow {
  nbaPlayerId: string
  fullName: string | null
  teamAbbr: string | null
  highestTierOwned: Tier
  totalAllowed: number
  timesUsed: number
  remainingUses: number
  datesUsed: string[]
  bestMomentId: string | null
  bestSerial: number | null
}

interface UsesResponse {
  runId: string
  uses: UseRow[]
}

interface SaveResponse {
  ok: boolean
  idempotent?: boolean
  firstSave?: boolean
  lineupId: string | null
  added: string[]
  removed: string[]
  useCounts: Array<{ nbaPlayerId: string; timesUsed: number; totalAllowed: number }>
}

interface Props {
  walletAddr: string
  runId: string
  runName: string
  lineupSize: 2 | 3
  hasCaptain: boolean
  gameDate: string
}

const TIER_TOKEN: Record<Tier, { color: string; bg: string; border: string; label: string }> = {
  COMMON:    { color: "var(--tier-common)",    bg: "var(--tier-common-bg)",    border: "var(--tier-common-border)",    label: "Common" },
  FANDOM:    { color: "var(--tier-fandom)",    bg: "var(--tier-fandom-bg)",    border: "var(--tier-fandom-border)",    label: "Fandom" },
  RARE:      { color: "var(--tier-rare)",      bg: "var(--tier-rare-bg)",      border: "var(--tier-rare-border)",      label: "Rare" },
  LEGENDARY: { color: "var(--tier-legendary)", bg: "var(--tier-legendary-bg)", border: "var(--tier-legendary-border)", label: "Legendary" },
  ULTIMATE:  { color: "var(--tier-ultimate)",  bg: "var(--tier-ultimate-bg)",  border: "var(--tier-ultimate-border)",  label: "Ultimate" },
}

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 14,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-secondary)",
  margin: "0 0 12px",
}

const HERO_STYLE: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-lg)",
  padding: 20,
  marginBottom: 24,
}

const CARD_STYLE: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-lg)",
  padding: 20,
}

const PLAYER_TILE: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-md)",
  padding: 14,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  position: "relative",
  minWidth: 0,
}

function thumbnailFor(momentId: string | null | undefined): string | null {
  if (!momentId) return null
  return `https://assets.nbatopshot.com/media/${momentId}/image?width=180`
}

function initialsFor(fullName: string | null | undefined): string {
  if (!fullName) return "??"
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "??"
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function TierChip({ tier, compact }: { tier: Tier; compact?: boolean }) {
  const t = TIER_TOKEN[tier] ?? TIER_TOKEN.COMMON
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        background: t.bg,
        color: t.color,
        border: `1px solid ${t.border}`,
        padding: compact ? "1px 6px" : "2px 8px",
        borderRadius: 999,
        fontFamily: "var(--font-mono)",
        fontSize: compact ? 9 : 10,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
      }}
    >
      {t.label}
    </span>
  )
}

function PlayerThumb({ momentId, fullName, tier }: { momentId: string | null | undefined; fullName: string | null | undefined; tier: Tier }) {
  const url = thumbnailFor(momentId ?? undefined)
  const initials = initialsFor(fullName)
  const tokens = TIER_TOKEN[tier] ?? TIER_TOKEN.COMMON
  const [errored, setErrored] = useState(false)
  if (!url || errored) {
    return (
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 999,
          background: tokens.bg,
          border: `1px solid ${tokens.border}`,
          color: tokens.color,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "var(--font-display)",
          fontWeight: 800,
          fontSize: 18,
          letterSpacing: "0.04em",
        }}
        aria-hidden
      >
        {initials}
      </div>
    )
  }
  return (
    // Plain <img/> is fine here — these are 64×64 thumbnails on a single
    // hero card, not worth pulling in next/image's full pipeline.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={fullName ?? ""}
      width={64}
      height={64}
      onError={() => setErrored(true)}
      style={{
        width: 64,
        height: 64,
        borderRadius: 999,
        objectFit: "cover",
        border: `1px solid ${tokens.border}`,
        background: tokens.bg,
      }}
    />
  )
}

interface Toast {
  kind: "success" | "idle" | "error"
  text: string
}

export default function FastBreakClient({
  walletAddr,
  runId,
  runName,
  lineupSize,
  hasCaptain,
  gameDate,
}: Props) {
  const [toast, setToast] = useState<Toast | null>(null)
  const [saving, setSaving] = useState(false)
  const [whyOpen, setWhyOpen] = useState(false)
  const [optimisticUses, setOptimisticUses] = useState<Record<string, number>>({})

  const optimizeKey = useMemo(
    () => `fb-optimize:${walletAddr}:${runId}:${gameDate}`,
    [walletAddr, runId, gameDate],
  )
  const usesKey = useMemo(() => `fb-uses:${walletAddr}:${runId}`, [walletAddr, runId])

  const optimize = useWarmCache<OptimizeResponse>(
    optimizeKey,
    async () => {
      const res = await fetch("/api/fast-break/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddr, runId }),
      })
      if (!res.ok) throw new Error(`optimize ${res.status}`)
      return (await res.json()) as OptimizeResponse
    },
    { ttlMs: 60_000 },
  )

  const uses = useWarmCache<UsesResponse>(
    usesKey,
    async () => {
      const res = await fetch(`/api/fast-break/uses?runId=${encodeURIComponent(runId)}`)
      if (!res.ok) throw new Error(`uses ${res.status}`)
      return (await res.json()) as UsesResponse
    },
    { ttlMs: 30_000 },
  )

  const save = useCallback(async () => {
    if (!optimize.data?.lineup) return
    setSaving(true)
    setToast(null)
    try {
      const lineup = optimize.data.lineup
      const players = lineup.players.map(p => ({
        nbaPlayerId: p.nbaPlayerId,
        momentId: p.bestMomentId,
        serial: p.bestSerial,
      }))
      const res = await fetch("/api/fast-break/lineup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddr,
          runId,
          gameDate,
          players,
          captainNbaPlayerId: hasCaptain ? lineup.captainNbaPlayerId : undefined,
        }),
      })
      const json: SaveResponse | { error?: string; playerId?: string } = await res.json()
      if (!res.ok) {
        const msg = (json as { error?: string }).error ?? `save_failed_${res.status}`
        setToast({ kind: "error", text: msg.replace(/_/g, " ") })
        return
      }
      const ok = json as SaveResponse
      if (ok.idempotent) {
        setToast({ kind: "idle", text: "Already saved for tonight" })
      } else {
        // Optimistic bump for newly-added players. Authoritative
        // useCounts come back in the response; we reconcile against
        // them after a short delay in case the user keeps tapping.
        const bumps: Record<string, number> = { ...optimisticUses }
        for (const id of ok.added) bumps[id] = (bumps[id] ?? 0) + 1
        for (const id of ok.removed) bumps[id] = Math.max(0, (bumps[id] ?? 0) - 1)
        setOptimisticUses(bumps)
        setToast({ kind: "success", text: "Lineup saved" })

        setTimeout(() => {
          // Authoritative reconciliation: refetch /api/fast-break/uses
          // so the widget pulls fresh totals straight from the DB.
          uses.refresh()
          setOptimisticUses({})
        }, 500)
      }
    } catch (err) {
      setToast({ kind: "error", text: err instanceof Error ? err.message : "save failed" })
    } finally {
      setSaving(false)
    }
  }, [optimize.data, walletAddr, runId, gameDate, hasCaptain, optimisticUses, uses])

  const lineup = optimize.data?.lineup ?? null
  const missing = optimize.data?.missingPlayers ?? []

  const useRows = useMemo<UseRow[]>(() => {
    const base = uses.data?.uses ?? []
    if (Object.keys(optimisticUses).length === 0) return base
    return base.map(r => {
      const bump = optimisticUses[r.nbaPlayerId] ?? 0
      const next = Math.max(0, Math.min(r.totalAllowed, r.timesUsed + bump))
      return { ...r, timesUsed: next, remainingUses: r.totalAllowed - next }
    })
  }, [uses.data, optimisticUses])

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* ── Hero lineup ──────────────────────────────────────── */}
      <div style={HERO_STYLE}>
        <div style={SECTION_HEADER}>Recommended Lineup · {runName}</div>

        {optimize.loading && !optimize.data ? (
          <LineupSkeleton lineupSize={lineupSize} />
        ) : optimize.error ? (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-danger)" }}>
            Failed to load optimizer. <button onClick={optimize.refresh} className="rpc-btn-ghost" style={{ marginLeft: 8 }}>Retry</button>
          </div>
        ) : !lineup ? (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
            {optimize.data?.consideredCount === 0
              ? "None of your eligible Top Shot players are on tonight's slate. Check back closer to tipoff."
              : "Couldn't build a lineup with your current eligibility. Try adding a Common-tier player to your wallet."}
          </div>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: `repeat(${Math.min(lineupSize, 3)}, minmax(0, 1fr))`,
                gap: 12,
              }}
            >
              {lineup.players.map(p => {
                const isCaptain = hasCaptain && lineup.captainNbaPlayerId === p.nbaPlayerId
                return (
                  <div key={p.nbaPlayerId} style={PLAYER_TILE}>
                    {isCaptain && (
                      <span
                        title="Captain"
                        style={{
                          position: "absolute",
                          top: -8,
                          right: -8,
                          width: 26,
                          height: 26,
                          borderRadius: 999,
                          background: "var(--tier-legendary)",
                          color: "#1a1a1a",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 14,
                          fontWeight: 900,
                          boxShadow: "0 0 0 2px var(--rpc-surface)",
                        }}
                        aria-label="Captain"
                      >
                        ★
                      </span>
                    )}
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <PlayerThumb momentId={p.bestMomentId} fullName={p.fullName} tier={p.highestTier} />
                      <div style={{ minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: "var(--font-display)",
                            fontWeight: 800,
                            fontSize: 16,
                            letterSpacing: "0.04em",
                            color: "var(--rpc-text-primary)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                          title={p.fullName}
                        >
                          {p.fullName}
                        </div>
                        <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", color: "var(--rpc-text-secondary)", textTransform: "uppercase" }}>
                          {p.teamAbbr} · vs {p.opponentTeamAbbr || "—"}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
                      <TierChip tier={p.highestTier} compact />
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.08em", color: "var(--rpc-text-muted)" }}>
                        Serial #{p.bestSerial}
                      </span>
                    </div>
                    <div
                      style={{
                        marginTop: 4,
                        fontFamily: "var(--font-display)",
                        fontSize: 22,
                        fontWeight: 800,
                        color: "var(--rpc-red)",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {p.projPoints.toFixed(1)} <span style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginLeft: 4 }}>FP</span>
                    </div>
                  </div>
                )
              })}
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 18 }}>
              <button
                onClick={save}
                disabled={saving}
                className="rpc-btn-primary"
                style={{ opacity: saving ? 0.6 : 1 }}
              >
                {saving ? "Saving…" : "Save This Lineup"}
              </button>
              <button
                onClick={() => setWhyOpen(v => !v)}
                className="rpc-btn-ghost"
                aria-expanded={whyOpen}
              >
                {whyOpen ? "Hide rationale" : "Why this lineup?"}
              </button>
              {toast && <ToastBanner toast={toast} />}
            </div>

            {whyOpen && (
              <div
                style={{
                  marginTop: 14,
                  padding: 14,
                  background: "rgba(255,255,255,0.03)",
                  border: "1px dashed var(--rpc-border)",
                  borderRadius: "var(--radius-md)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: "var(--rpc-text-secondary)",
                  lineHeight: 1.7,
                }}
              >
                <div>
                  Total projected score: <strong style={{ color: "var(--rpc-text-primary)" }}>{lineup.projectedScore.toFixed(1)}</strong> FP across {lineup.players.length} players.
                </div>
                <div>
                  Serial sum: <strong style={{ color: "var(--rpc-text-primary)" }}>{lineup.serialSum}</strong>. When two lineup combinations project within 5% of each other, lower serial sum wins the tiebreaker — Top Shot&apos;s Run leaderboard ranks ties by lowest combined #serial.
                </div>
                <div>
                  Considered {optimize.data?.consideredCount ?? 0} of your {optimize.data?.eligibleCount ?? 0} eligible players (the rest aren&apos;t on tonight&apos;s slate or are listed OUT).
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Acquisition gap ──────────────────────────────────── */}
      {missing.length > 0 && (
        <div style={CARD_STYLE}>
          <div style={SECTION_HEADER}>Acquisition Gap</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 12, lineHeight: 1.6 }}>
            Top-projected players you don&apos;t currently have available. Pick one up to lift tomorrow&apos;s lineup ceiling.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {missing.map(m => (
              <div
                key={m.nbaPlayerId}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                  padding: "10px 12px",
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: "var(--radius-md)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, letterSpacing: "0.04em", color: "var(--rpc-text-primary)" }}>
                    {m.fullName ?? "Unknown player"} <span style={{ color: "var(--rpc-text-muted)", fontWeight: 500 }}>· {m.teamAbbr ?? "—"}</span>
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.1em", color: "var(--rpc-text-secondary)", marginTop: 2 }}>
                    {m.projFp != null ? `${m.projFp.toFixed(1)} FP projected` : "no projection"} · you don&apos;t have remaining uses on this player tonight
                  </div>
                </div>
                {m.cheapestListing && m.cheapestListing.momentId ? (
                  <a
                    href={`/nba-top-shot/sniper?moment=${encodeURIComponent(m.cheapestListing.momentId)}`}
                    className="rpc-btn-primary"
                    style={{ textDecoration: "none" }}
                  >
                    Buy on Sniper · ${m.cheapestListing.askUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </a>
                ) : (
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)" }}>
                    Not currently listed
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Run progress ─────────────────────────────────────── */}
      <div style={CARD_STYLE}>
        <div style={{ ...SECTION_HEADER, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>Run Progress</span>
          <button onClick={uses.refresh} className="rpc-btn-ghost" style={{ padding: "4px 10px", fontSize: 10 }}>
            Refresh
          </button>
        </div>
        {uses.loading && !uses.data ? (
          <UsesSkeleton />
        ) : useRows.length === 0 ? (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}>
            No lineups saved yet. Save tonight&apos;s lineup to start the run.
          </div>
        ) : (
          <RunProgressByTier rows={useRows} />
        )}
      </div>
    </div>
  )
}

function ToastBanner({ toast }: { toast: Toast }) {
  if (toast.kind === "success") {
    return (
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-success)", letterSpacing: "0.06em" }}>
        ✓ {toast.text}
      </span>
    )
  }
  if (toast.kind === "idle") {
    return (
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
        {toast.text}
      </span>
    )
  }
  return (
    <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-danger)", letterSpacing: "0.06em" }}>
      ✕ {toast.text}
    </span>
  )
}

function LineupSkeleton({ lineupSize }: { lineupSize: 2 | 3 }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(lineupSize, 3)}, minmax(0, 1fr))`, gap: 12 }}>
      {Array.from({ length: lineupSize }).map((_, i) => (
        <div key={i} style={{ ...PLAYER_TILE, height: 160 }}>
          <div style={{ width: 64, height: 64, borderRadius: 999, background: "rgba(255,255,255,0.05)" }} />
          <div style={{ width: "70%", height: 14, background: "rgba(255,255,255,0.05)", borderRadius: 4 }} />
          <div style={{ width: "40%", height: 10, background: "rgba(255,255,255,0.05)", borderRadius: 4 }} />
        </div>
      ))}
    </div>
  )
}

function UsesSkeleton() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} style={{ height: 14, background: "rgba(255,255,255,0.05)", borderRadius: 4 }} />
      ))}
    </div>
  )
}

const TIER_ORDER: Tier[] = ["ULTIMATE", "LEGENDARY", "RARE", "FANDOM", "COMMON"]

function RunProgressByTier({ rows }: { rows: UseRow[] }) {
  const grouped = TIER_ORDER.map(tier => {
    const tierRows = rows.filter(r => r.highestTierOwned === tier)
    if (tierRows.length === 0) return null
    return { tier, rows: tierRows }
  }).filter(Boolean) as { tier: Tier; rows: UseRow[] }[]

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {grouped.map(g => {
        const t = TIER_TOKEN[g.tier]
        return (
          <div key={g.tier} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <span
              style={{
                background: t.bg,
                color: t.color,
                border: `1px solid ${t.border}`,
                padding: "2px 8px",
                borderRadius: 4,
                fontFamily: "var(--font-mono)",
                fontSize: 9,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                flexShrink: 0,
              }}
            >
              {t.label}
            </span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {g.rows.map(r => (
                <span
                  key={r.nbaPlayerId}
                  title={`${r.fullName ?? r.nbaPlayerId} · ${r.timesUsed}/${r.totalAllowed}`}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: r.remainingUses === 0 ? "var(--rpc-text-muted)" : "var(--rpc-text-secondary)",
                    letterSpacing: "0.04em",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid var(--rpc-border)",
                    padding: "2px 8px",
                    borderRadius: 999,
                    whiteSpace: "nowrap",
                  }}
                >
                  {r.fullName ?? "?"} {r.timesUsed}/{r.totalAllowed}
                </span>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
