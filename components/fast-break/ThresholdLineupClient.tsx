"use client"
// components/fast-break/ThresholdLineupClient.tsx
//
// Regular-season Fast Break (2026-27): tonight's stat targets, the five players plus
// Captain from the collector's own wallet most likely to clear them, a bench pick, and
// how the best lineup from the whole slate compares. Reads /api/fast-break/tonight;
// saving reuses /api/fast-break/lineup, which counts the plays against each Moment's
// uses for the run. The playoff format ("score the most points") stays in
// FastBreakClient.tsx.

import { useCallback, useMemo, useState } from "react"
import { answerFor } from "@/lib/warmup/answer-for"
import { useWarmCache } from "@/lib/warmup/WarmupContext"
import { tierToken, type Tier } from "@/lib/fast-break-client-compute"
import type { StatKey, TargetOutlook, ThresholdPlayer } from "@/lib/fast-break/threshold-optimizer"

interface TonightLineup {
  players: ThresholdPlayer[]
  captainNbaPlayerId: string | null
  bench: ThresholdPlayer | null
  winProbability: number
  targets: TargetOutlook[]
  serialSum: number
}

interface TonightResponse {
  runName: string
  gameDate: string
  dataStatus: "ok" | "no_games" | "slate_unavailable" | "projections_unavailable" | "targets_unknown" | "pro_eligibility_unknown"
  objective: string | null
  targets: Partial<Record<StatKey, number>>
  lineupSize: number
  hasCaptain: boolean
  eligibleCount: number
  onSlateCount: number
  lineup: TonightLineup | null
  trackRecord?: { scored: number; cleared: number; avgPredicted: number | null; pending: number } | null
  trackRecordFailed?: boolean
  slateBest: {
    winProbability: number
    missing: Array<{ nbaPlayerId: string; fullName: string | null; teamAbbr: string | null; reason: "not_owned" | "no_uses_left" }>
  } | null
}

interface Props {
  walletAddr: string
  runId: string
  gameDate: string
  /** Classic or Pro run (they run side by side); only changes the label here. */
  mode?: "classic" | "pro"
}

const CARD: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-lg)",
  padding: 20,
}

const LABEL: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-muted)",
}

const HEADING: React.CSSProperties = {
  fontFamily: "var(--font-display)",
  fontWeight: 900,
  fontSize: 14,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-secondary)",
  margin: "0 0 12px",
}

const STAT_SHORT: Record<StatKey, string> = {
  pts: "PTS", reb: "REB", ast: "AST", stl: "STL", blk: "BLK", tov: "TO",
  fg3m: "3PM", fg3a: "3PA", fgm: "FGM", fga: "FGA", ftm: "FTM", fta: "FTA",
}

function pct(p: number): string {
  if (p >= 0.995) return ">99%"
  if (p < 0.005) return "<1%"
  return `${Math.round(p * 100)}%`
}

function usesLabel(p: ThresholdPlayer): string {
  if (p.remainingUses == null) return "Unlimited uses"
  return `${p.remainingUses} of ${p.totalUses ?? "?"} uses left`
}

function TierChip({ tier }: { tier: string }) {
  const t = tierToken((tier?.toUpperCase() as Tier) ?? "COMMON")
  return (
    <span style={{
      display: "inline-flex", background: t.bg, color: t.color, border: `1px solid ${t.border}`,
      padding: "1px 6px", borderRadius: 999, fontFamily: "var(--font-mono)", fontSize: 9,
      letterSpacing: "0.12em", textTransform: "uppercase",
    }}>{t.label}</span>
  )
}

function TargetBar({ t }: { t: TargetOutlook }) {
  const fill = Math.min(1, t.projected / Math.max(1, t.target))
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)" }}>
        <span>{t.label}</span>
        <span>
          <strong style={{ color: "var(--rpc-text-primary)" }}>{t.projected.toFixed(1)}</strong> / {t.target}
          <span style={{ marginLeft: 8, color: "var(--rpc-text-muted)" }}>{pct(t.probability)}</span>
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.06)", overflow: "hidden" }}>
        <div style={{ width: `${fill * 100}%`, height: "100%", background: fill >= 1 ? "var(--rpc-success, #3fb950)" : "var(--rpc-red-fill)" }} />
      </div>
    </div>
  )
}

function PlayerRow({ p, captain, keys }: { p: ThresholdPlayer; captain: boolean; keys: StatKey[] }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, padding: "10px 12px",
      border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-md)",
      background: captain ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.02)", minWidth: 0,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 15, color: "var(--rpc-text-primary)" }}>{p.fullName}</span>
          {captain && (
            <span style={{ ...LABEL, color: "var(--rpc-text-primary)", border: "1px solid var(--rpc-border)", borderRadius: 999, padding: "1px 6px" }}>Captain 1.5×</span>
          )}
          <TierChip tier={p.highestTier} />
        </div>
        <div style={{ ...LABEL, marginTop: 3 }}>
          {p.teamAbbr}{p.opponentTeamAbbr ? ` vs ${p.opponentTeamAbbr}` : ""} · {usesLabel(p)}
          {p.injuryStatus && p.injuryStatus.toUpperCase() !== "ACTIVE" ? ` · ${p.injuryStatus.replace(/_/g, " ")}` : ""}
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, flexShrink: 0 }}>
        {keys.map(k => (
          <div key={k} style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 14, color: "var(--rpc-text-primary)" }}>{(p.proj[k] ?? 0).toFixed(1)}</div>
            <div style={LABEL}>{STAT_SHORT[k]}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function ThresholdLineupClient({ walletAddr, runId, gameDate, mode = "classic" }: Props) {
  const [toast, setToast] = useState<{ kind: "success" | "idle" | "error"; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const key = useMemo(() => `fb-tonight:${walletAddr}:${runId}:${gameDate}`, [walletAddr, runId, gameDate])

  const tonight = useWarmCache<TonightResponse>(
    key,
    async () => {
      const res = await fetch("/api/fast-break/tonight", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddr, runId, gameDate }),
      })
      if (!res.ok) throw new Error(`tonight ${res.status}`)
      return (await res.json()) as TonightResponse
    },
    { ttlMs: 60_000 },
  )
  const data = useMemo(() => answerFor(tonight.data, tonight.dataKey, key), [tonight.data, tonight.dataKey, key])
  const lineup = data?.lineup ?? null
  const keys = useMemo(() => Object.keys(data?.targets ?? {}) as StatKey[], [data])

  const save = useCallback(async () => {
    if (!lineup) return
    setSaving(true)
    setToast(null)
    try {
      const res = await fetch("/api/fast-break/lineup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          walletAddr,
          runId,
          gameDate,
          players: lineup.players.map(p => ({ nbaPlayerId: p.nbaPlayerId, momentId: p.bestMomentId, serial: p.bestSerial })),
          captainNbaPlayerId: lineup.captainNbaPlayerId ?? undefined,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setToast({ kind: "error", text: String(json?.error ?? `save failed (${res.status})`).replace(/_/g, " ") })
        return
      }
      setToast(json?.idempotent ? { kind: "idle", text: "Already saved for tonight" } : { kind: "success", text: "Lineup saved — plays counted against this run" })
      tonight.refresh()
    } catch (err) {
      setToast({ kind: "error", text: err instanceof Error ? err.message : "save failed" })
    } finally {
      setSaving(false)
    }
  }, [lineup, walletAddr, runId, gameDate, tonight])

  if (!data) {
    return (
      <div style={CARD}>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-muted)" }}>
          {tonight.error ? "Couldn't build tonight's lineup. This is a problem on our side — reload in a moment." : "Building tonight's lineup…"}
        </div>
      </div>
    )
  }

  const statusCopy: Record<Exclude<TonightResponse["dataStatus"], "ok">, string> = {
    no_games: "No NBA games tonight, so there's no Fast Break night to play.",
    slate_unavailable: "Tonight's NBA schedule couldn't be loaded. This is our data, not your roster.",
    projections_unavailable: "Tonight's projections aren't in yet. This is our data, not your roster.",
    targets_unknown: "Tonight's Fast Break targets haven't been recorded on RPC yet. Check back shortly.",
    pro_eligibility_unknown:
      "Pro nights only allow some Moments, and RPC hasn't read tonight's eligible list from Top Shot yet. Use the Sync from Top Shot button below while signed in to Top Shot.",
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={CARD}>
        <div style={LABEL}>{mode === "pro" ? "Pro · " : ""}Tonight · {data.gameDate}</div>
        <div style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 22, color: "var(--rpc-text-primary)", margin: "6px 0 14px", letterSpacing: "0.02em" }}>
          {data.objective ?? "Targets not recorded yet"}
        </div>

        {data.dataStatus !== "ok" ? (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-muted)" }}>{statusCopy[data.dataStatus]}</div>
        ) : !lineup ? (
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-muted)" }}>
            {data.onSlateCount === 0
              ? "None of your players are on tonight's slate."
              : `Only ${data.onSlateCount} of your players are on tonight's slate with plays left — a lineup needs ${data.lineupSize}.`}
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <span style={{ fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 40, color: "var(--rpc-text-primary)" }}>{pct(lineup.winProbability)}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)" }}>
                chance to clear every target with your best lineup
                {data.slateBest ? ` · best lineup on the whole slate: ${pct(data.slateBest.winProbability)}` : ""}
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
              {lineup.targets.map(t => <TargetBar key={t.stat} t={t} />)}
            </div>

            <h2 style={HEADING}>Your lineup</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {lineup.players.map(p => (
                <PlayerRow key={p.nbaPlayerId} p={p} captain={lineup.captainNbaPlayerId === p.nbaPlayerId} keys={keys} />
              ))}
            </div>
            {lineup.bench && (
              <>
                <div style={{ ...LABEL, margin: "14px 0 6px" }}>Bench — subs in if a starter sits</div>
                <PlayerRow p={lineup.bench} captain={false} keys={keys} />
              </>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
              <button type="button" className="rpc-btn-primary" onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save this lineup"}
              </button>
              {toast && (
                <span role="status" style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: toast.kind === "error" ? "var(--rpc-red-text, var(--rpc-red-fill))" : "var(--rpc-text-secondary)" }}>
                  {toast.text}
                </span>
              )}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 12, lineHeight: 1.6 }}>
              Set your lineup on Top Shot — RPC doesn&apos;t submit it. Saving here counts each play against that Moment&apos;s uses for the run, so later nights plan around who you have left.
            </div>
          </>
        )}
      </div>

      {data.dataStatus === "ok" && data.slateBest && data.slateBest.missing.length > 0 && (
        <div style={CARD}>
          <h2 style={HEADING}>Who would make it easier</h2>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6, marginBottom: 10 }}>
            The best lineup on tonight&apos;s whole slate ({pct(data.slateBest.winProbability)}) uses players you can&apos;t play tonight:
          </div>
          <ul style={{ margin: 0, paddingLeft: 18, fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--rpc-text-primary)", lineHeight: 1.8 }}>
            {data.slateBest.missing.map(m => (
              <li key={m.nbaPlayerId}>
                {m.fullName ?? "Name unavailable"}{m.teamAbbr ? ` (${m.teamAbbr})` : ""}
                <span style={{ color: "var(--rpc-text-muted)" }}> — {m.reason === "not_owned" ? "not in your collection" : "no uses left this run"}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.6 }}>
        {data.trackRecordFailed
          ? "RPC's record for this run couldn't be loaded. "
          : data.trackRecord && data.trackRecord.scored > 0
            ? `This run, the best lineup RPC picked from the whole slate cleared ${data.trackRecord.cleared} of ${data.trackRecord.scored} night${data.trackRecord.scored === 1 ? "" : "s"}; it had given those nights a ${Math.round((data.trackRecord.avgPredicted ?? 0) * 100)}% chance on average. `
            : ""}
        Projections blend ESPN&apos;s season numbers with each player&apos;s games so far. The chance shown is an estimate from how much each stat swings night to night — a guide, not a promise.
      </div>
    </div>
  )
}
