"use client"
// components/rtr/RTRClient.tsx
//
// The interactive heart of /[collection]/road-to-the-ring. Three
// sections, top-to-bottom:
//   1. Tonight's Pick   — stub until the Odds API is wired (Prompt 1B)
//   2. Tier Progress    — GET / POST /api/rtr/state
//   3. Lock ROI         — POST /api/rtr/lock-roi (5-min server cache)
//
// Inherits useWarmCache, design tokens, and the gate pattern from
// FastBreakClient.tsx. RTR state TTL 60s, lock-roi TTL 300s (matches
// the route's in-process cache).

import { useCallback, useMemo, useState } from "react"
import { useWarmCache } from "@/lib/warmup/WarmupContext"

// ── Tonight's Pick ────────────────────────────────────────────────────

interface LivePick {
  gameId: string
  homeTeam: string
  awayTeam: string
  recommendedSide: "home_ml" | "away_ml"
  impliedProbability: number
  rationale: string
  homeML: number
  awayML: number
  tipoffAt: string | null
  bookmaker: string | null
  oddsLastSyncedAt: string
}

interface PicksResponse {
  picks: LivePick[]
  message?: string
  note?: string
}

// ── Tier Progress ─────────────────────────────────────────────────────

type TierName = "Prospect" | "Starter" | "All-Star" | "All-NBA" | "MVP" | "Legend"

interface RtrState {
  reportedTotalPoints: number
  reportedSpendableBalance: number
  currentTier: TierName
  reportedAt: string | null
  updatedAt: string | null
}

const TIER_THRESHOLDS: { name: TierName; min: number; max: number }[] = [
  { name: "Prospect", min: 0,       max: 999       },
  { name: "Starter",  min: 1000,    max: 9999      },
  { name: "All-Star", min: 10000,   max: 39999     },
  { name: "All-NBA",  min: 40000,   max: 99999     },
  { name: "MVP",      min: 100000,  max: 199999    },
  { name: "Legend",   min: 200000,  max: Infinity  },
]

function tierFor(points: number): { name: TierName; min: number; max: number } {
  for (let i = TIER_THRESHOLDS.length - 1; i >= 0; i--) {
    if (points >= TIER_THRESHOLDS[i].min) return TIER_THRESHOLDS[i]
  }
  return TIER_THRESHOLDS[0]
}

function relativeTimeAgo(iso: string | null): string {
  if (!iso) return "never"
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "never"
  const delta = Date.now() - ms
  if (delta < 60_000) return "just now"
  const min = Math.round(delta / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const days = Math.round(hr / 24)
  return `${days}d ago`
}

// ── Lock ROI ─────────────────────────────────────────────────────────

interface LockRoiRow {
  momentId: string
  playerName: string | null
  setName: string | null
  currentFmvUsd: number
  isLocked: boolean
  estimatedPlayoffPoints: number
  pointsPerDollar: number
  serialNumber: number | null
  tier: string | null
}

interface LockRoiResponse {
  walletAddr: string
  rowCount: number
  totalAvailable: number
  moments: LockRoiRow[]
}

type LockRoiSortKey = "pointsPerDollar" | "currentFmvUsd" | "estimatedPlayoffPoints" | "playerName" | "setName"
type LockRoiSortDir = "asc" | "desc"

// ── Shared styles ────────────────────────────────────────────────────

const SECTION_HEADER: React.CSSProperties = {
  fontFamily: "'Barlow Condensed', sans-serif",
  fontWeight: 900,
  fontSize: 14,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: "var(--rpc-text-secondary)",
  margin: "0 0 12px",
}

const CARD_STYLE: React.CSSProperties = {
  background: "var(--rpc-surface)",
  border: "1px solid var(--rpc-border)",
  borderRadius: "var(--radius-lg)",
  padding: 20,
}

// ── Component ────────────────────────────────────────────────────────

export default function RTRClient({ walletAddr }: { walletAddr: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <TonightsPickSection />
      <TierProgressSection walletAddr={walletAddr} />
      <LockRoiSection walletAddr={walletAddr} />
    </div>
  )
}

// ── Section 1: Tonight's Pick (stub) ────────────────────────────────

function TonightsPickSection() {
  const [whyOpen, setWhyOpen] = useState(false)

  const picks = useWarmCache<PicksResponse>(
    "rtr-picks-today",
    async () => {
      const res = await fetch("/api/rtr/picks/today")
      if (!res.ok) throw new Error(`picks ${res.status}`)
      return (await res.json()) as PicksResponse
    },
    { ttlMs: 60_000 },
  )

  const top: LivePick | null = picks.data?.picks?.[0] ?? null
  const isEmpty = !picks.loading && !top
  const noFreshNote = picks.data?.message === "no_fresh_odds" ? picks.data?.note ?? null : null

  return (
    <div style={CARD_STYLE}>
      <div style={SECTION_HEADER}>Tonight&apos;s Pick</div>
      {picks.loading && !picks.data ? (
        <div style={{ height: 60, background: "rgba(255,255,255,0.04)", borderRadius: "var(--radius-md)" }} />
      ) : isEmpty ? (
        <div
          style={{
            display: "flex", alignItems: "flex-start", gap: 14, padding: 18,
            background: "rgba(224,58,47,0.05)",
            border: "1px dashed var(--rpc-red-border)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <div
            aria-hidden
            style={{
              flexShrink: 0, width: 36, height: 36, borderRadius: 999,
              background: "var(--rpc-red-bg)", border: "1px solid var(--rpc-red-border)",
              color: "var(--rpc-red)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
            }}
          >
            ⚡
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 16, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", marginBottom: 4 }}>
              No game odds available right now
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.7 }}>
              {noFreshNote ?? "Odds refresh hourly during NBA active hours. Check back closer to tipoff for tonight's recommended pick."}
            </div>
          </div>
        </div>
      ) : top ? (
        <LivePickCard pick={top} whyOpen={whyOpen} setWhyOpen={setWhyOpen} />
      ) : null}
    </div>
  )
}

function LivePickCard({
  pick, whyOpen, setWhyOpen,
}: { pick: LivePick; whyOpen: boolean; setWhyOpen: (v: boolean | ((prev: boolean) => boolean)) => void }) {
  const sideTeam = pick.recommendedSide === "home_ml" ? pick.homeTeam : pick.awayTeam
  const opposingTeam = pick.recommendedSide === "home_ml" ? pick.awayTeam : pick.homeTeam
  const sideMl = pick.recommendedSide === "home_ml" ? pick.homeML : pick.awayML
  const pct = Math.round(pick.impliedProbability * 100)
  const tipoffLabel = pick.tipoffAt ? formatTipoff(pick.tipoffAt) : null
  const oddsAge = formatOddsAge(pick.oddsLastSyncedAt)

  return (
    <div
      style={{
        display: "flex", flexDirection: "column", gap: 14, padding: 18,
        background: "rgba(224,58,47,0.06)",
        border: "1px solid var(--rpc-red-border)",
        borderRadius: "var(--radius-md)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div
          aria-hidden
          style={{
            flexShrink: 0, width: 44, height: 44, borderRadius: 999,
            background: "var(--rpc-red)", color: "#fff",
            display: "flex", alignItems: "center", justifyContent: "center",
            fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 18, letterSpacing: "0.02em",
          }}
        >
          {sideTeam.slice(0, 3).toUpperCase()}
        </div>
        <div style={{ flex: 1, minWidth: "min(200px, 100%)" }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 22, letterSpacing: "0.04em", color: "var(--rpc-text-primary)", textTransform: "uppercase" }}>
            {sideTeam} ML
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em", marginTop: 4 }}>
            vs {opposingTeam}
            {tipoffLabel ? ` · ${tipoffLabel}` : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 900, fontSize: 28, color: "var(--rpc-red)", lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
            {pct}%
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 4 }}>
            de-vigged
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
        <span>ML {formatAmericanOdds(sideMl)}</span>
        {pick.bookmaker && <span>· via {pick.bookmaker}</span>}
        <span>· odds {oddsAge}</span>
      </div>

      <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.7 }}>
        {pick.rationale}
      </div>

      <div>
        <button
          onClick={() => setWhyOpen(v => !v)}
          className="rpc-btn-ghost"
          aria-expanded={whyOpen}
          style={{ padding: "4px 10px", fontSize: 10 }}
        >
          {whyOpen ? "Hide explanation" : "Why does this matter?"}
        </button>
        {whyOpen && (
          <div
            style={{
              marginTop: 12, padding: 12,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid var(--rpc-border)",
              borderRadius: "var(--radius-md)",
              fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", lineHeight: 1.7,
            }}
          >
            Picks are pure +EV with a downside floor: a wrong answer refunds your full balance, while a correct answer pays out. The optimal v1 strategy is therefore &quot;all-in on the night&apos;s highest-implied-probability outcome.&quot; Splitting becomes useful only once we model covariance across same-night games — out of scope for v1.
          </div>
        )}
      </div>
    </div>
  )
}

function formatAmericanOdds(odds: number): string {
  if (!Number.isFinite(odds) || odds === 0) return "—"
  return odds > 0 ? `+${odds}` : String(odds)
}

function formatTipoff(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ""
  // Use Intl with no explicit timezone so the user's local TZ wins on
  // hydration. SSR will render UTC briefly; that's acceptable.
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(ms))
}

function formatOddsAge(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return "unknown"
  const delta = Date.now() - ms
  if (delta < 60_000) return "just now"
  const min = Math.round(delta / 60_000)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  return `${hr}h ago`
}

// ── Section 2: Tier Progress ─────────────────────────────────────────

function TierProgressSection({ walletAddr: _walletAddr }: { walletAddr: string }) {
  const [pointsInput, setPointsInput] = useState("")
  const [balanceInput, setBalanceInput] = useState("")
  const [saving, setSaving] = useState(false)
  const [optimisticState, setOptimisticState] = useState<RtrState | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const state = useWarmCache<RtrState>(
    "rtr-state",
    async () => {
      const res = await fetch("/api/rtr/state")
      if (!res.ok) throw new Error(`state ${res.status}`)
      return (await res.json()) as RtrState
    },
    { ttlMs: 60_000 },
  )

  const current = optimisticState ?? state.data
  const currentTier = current ? tierFor(current.reportedTotalPoints) : TIER_THRESHOLDS[0]
  const pointsForBar = current?.reportedTotalPoints ?? 0

  const tierIndex = TIER_THRESHOLDS.findIndex(t => t.name === currentTier.name)
  const nextTier = tierIndex >= 0 && tierIndex < TIER_THRESHOLDS.length - 1 ? TIER_THRESHOLDS[tierIndex + 1] : null
  const lower = currentTier.min
  const upper = nextTier ? nextTier.min : currentTier.min
  const span = Math.max(1, upper - lower)
  const progressPct = nextTier
    ? Math.min(100, Math.max(0, ((pointsForBar - lower) / span) * 100))
    : 100

  const save = useCallback(async () => {
    const points = Number(pointsInput)
    const balance = Number(balanceInput)
    if (!Number.isFinite(points) || points < 0 || !Number.isFinite(balance) || balance < 0) {
      setErrorMsg("Enter non-negative numbers for both fields")
      return
    }
    setErrorMsg(null)
    setSaving(true)

    const optimistic: RtrState = {
      reportedTotalPoints: Math.floor(points),
      reportedSpendableBalance: Math.floor(balance),
      currentTier: tierFor(points).name,
      reportedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setOptimisticState(optimistic)

    try {
      const res = await fetch("/api/rtr/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reportedTotalPoints: Math.floor(points),
          reportedSpendableBalance: Math.floor(balance),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `save_failed_${res.status}`)
      }
      const fresh = (await res.json()) as RtrState
      setOptimisticState(fresh)
      setPointsInput("")
      setBalanceInput("")
      // Reconcile the warm cache on a short delay so the GET returns
      // the freshly-saved row instead of the pre-save snapshot.
      setTimeout(() => {
        state.refresh()
        setOptimisticState(null)
      }, 500)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "save failed")
      setOptimisticState(null)
    } finally {
      setSaving(false)
    }
  }, [pointsInput, balanceInput, state])

  return (
    <div style={CARD_STYLE}>
      <div style={SECTION_HEADER}>Tier Progress</div>

      {state.loading && !state.data ? (
        <div style={{ height: 96, background: "rgba(255,255,255,0.04)", borderRadius: "var(--radius-md)" }} />
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 22, letterSpacing: "0.04em", color: "var(--rpc-text-primary)" }}>
              {currentTier.name}
            </div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)", letterSpacing: "0.06em" }}>
              {pointsForBar.toLocaleString()} pts
              {nextTier ? ` · ${(nextTier.min - pointsForBar).toLocaleString()} to ${nextTier.name}` : " · max tier"}
            </div>
          </div>

          <div
            role="progressbar"
            aria-valuenow={Math.round(progressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Progress to ${nextTier?.name ?? "max tier"}`}
            style={{
              position: "relative",
              height: 10,
              background: "rgba(255,255,255,0.05)",
              border: "1px solid var(--rpc-border)",
              borderRadius: 999,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                bottom: 0,
                width: `${progressPct}%`,
                background: "linear-gradient(90deg, var(--rpc-red), var(--rpc-red-hover))",
                transition: "width 0.4s ease",
              }}
            />
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>
            <span>{lower.toLocaleString()}</span>
            <span>{nextTier ? upper.toLocaleString() : "∞"}</span>
          </div>

          <div style={{ marginTop: 18, padding: 14, background: "rgba(255,255,255,0.03)", border: "1px solid var(--rpc-border)", borderRadius: "var(--radius-md)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
              <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--rpc-text-primary)" }}>
                Refresh my balance
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}>
                Last reported: {relativeTimeAgo(current?.reportedAt ?? null)}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 10, alignItems: "end" }}>
              <NumberInput
                label="Total Playoffs Points"
                value={pointsInput}
                onChange={setPointsInput}
                placeholder={String(current?.reportedTotalPoints ?? 0)}
              />
              <NumberInput
                label="Spendable Balance"
                value={balanceInput}
                onChange={setBalanceInput}
                placeholder={String(current?.reportedSpendableBalance ?? 0)}
              />
              <button
                onClick={save}
                disabled={saving || !pointsInput || !balanceInput}
                className="rpc-btn-primary"
                style={{ opacity: saving || !pointsInput || !balanceInput ? 0.6 : 1, height: 38 }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            {errorMsg && (
              <div style={{ marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-danger)" }}>
                {errorMsg}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function NumberInput({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.12em", color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>
        {label}
      </span>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={10_000_000}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          background: "var(--rpc-surface)",
          border: "1px solid var(--rpc-border)",
          borderRadius: "var(--radius-sm)",
          padding: "8px 10px",
          color: "var(--rpc-text-primary)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          height: 38,
        }}
      />
    </label>
  )
}

// ── Section 3: Lock ROI ──────────────────────────────────────────────

function LockRoiSection({ walletAddr }: { walletAddr: string }) {
  const [sortKey, setSortKey] = useState<LockRoiSortKey>("pointsPerDollar")
  const [sortDir, setSortDir] = useState<LockRoiSortDir>("desc")

  const data = useWarmCache<LockRoiResponse>(
    `rtr-lock-roi:${walletAddr}`,
    async () => {
      const res = await fetch("/api/rtr/lock-roi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ walletAddr }),
      })
      if (!res.ok) throw new Error(`lock-roi ${res.status}`)
      return (await res.json()) as LockRoiResponse
    },
    { ttlMs: 300_000 },
  )

  const sorted = useMemo(() => {
    const rows = data.data?.moments ?? []
    const out = rows.slice()
    out.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      let cmp = 0
      if (typeof av === "number" && typeof bv === "number") cmp = av - bv
      else cmp = String(av ?? "").localeCompare(String(bv ?? ""))
      return sortDir === "asc" ? cmp : -cmp
    })
    return out
  }, [data.data, sortKey, sortDir])

  const topAccentSet = useMemo(() => new Set(sorted.slice(0, 5).map(m => m.momentId)), [sorted])
  const bottomAccentSet = useMemo(() => new Set(sorted.slice(-5).map(m => m.momentId)), [sorted])

  function setSort(key: LockRoiSortKey) {
    if (key === sortKey) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"))
    } else {
      setSortKey(key)
      setSortDir("desc")
    }
  }

  return (
    <div style={CARD_STYLE}>
      <div style={{ ...SECTION_HEADER, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span>Lock ROI</span>
        {data.data && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 9, letterSpacing: "0.1em", color: "var(--rpc-text-muted)", textTransform: "none" }}>
            {data.data.rowCount} of {data.data.totalAvailable} moments
          </span>
        )}
      </div>

      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--rpc-text-muted)",
          marginBottom: 12,
          lineHeight: 1.6,
        }}
      >
        Estimates are approximate. Lock ROI calibration improves over time as we observe scoring data — current formula is a v1 placeholder (FMV ÷ 10).
      </div>

      {data.loading && !data.data ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} style={{ height: 32, background: "rgba(255,255,255,0.05)", borderRadius: 4 }} />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--rpc-text-secondary)" }}>
          No moments with usable FMV in your wallet yet. Run the wallet search on /nba-top-shot/collection to populate the cache.
        </div>
      ) : (
        <>
          {/* Mobile sort dropdown — visible below 768px via @media in
              the inline style block below. */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }} className="rpc-rtr-mobile-sort">
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.12em", color: "var(--rpc-text-muted)", textTransform: "uppercase" }}>
              Sort
              <select
                value={`${sortKey}-${sortDir}`}
                onChange={e => {
                  const [k, d] = e.target.value.split("-") as [LockRoiSortKey, LockRoiSortDir]
                  setSortKey(k)
                  setSortDir(d)
                }}
                style={{
                  background: "var(--rpc-surface)",
                  border: "1px solid var(--rpc-border)",
                  borderRadius: "var(--radius-sm)",
                  color: "var(--rpc-text-primary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 8px",
                }}
              >
                <option value="pointsPerDollar-desc">Points / $ (highest first)</option>
                <option value="pointsPerDollar-asc">Points / $ (lowest first)</option>
                <option value="currentFmvUsd-desc">FMV (highest first)</option>
                <option value="currentFmvUsd-asc">FMV (lowest first)</option>
                <option value="estimatedPlayoffPoints-desc">Est points (highest first)</option>
                <option value="playerName-asc">Player (A → Z)</option>
              </select>
            </label>
          </div>

          {/* Desktop: sortable table */}
          <div className="rpc-rtr-table-wrap" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "var(--font-mono)", fontSize: 11 }}>
              <thead>
                <tr style={{ color: "var(--rpc-text-muted)", textAlign: "left", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                  <SortHeader label="Player"     col="playerName"             sortKey={sortKey} sortDir={sortDir} onClick={setSort} />
                  <SortHeader label="Set"        col="setName"                sortKey={sortKey} sortDir={sortDir} onClick={setSort} />
                  <SortHeader label="Current FMV" col="currentFmvUsd"          sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
                  <th style={{ padding: "8px 10px" }}>Locked?</th>
                  <SortHeader label="Est Pts"    col="estimatedPlayoffPoints" sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
                  <SortHeader label="Pts / $"    col="pointsPerDollar"        sortKey={sortKey} sortDir={sortDir} onClick={setSort} align="right" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(m => {
                  const accent = topAccentSet.has(m.momentId)
                    ? "var(--rpc-success)"
                    : bottomAccentSet.has(m.momentId)
                      ? "var(--rpc-danger)"
                      : "transparent"
                  return (
                    <tr
                      key={m.momentId}
                      style={{
                        borderBottom: "1px solid var(--rpc-border)",
                        borderLeft: `3px solid ${accent}`,
                      }}
                    >
                      <td style={{ padding: "8px 10px", color: "var(--rpc-text-primary)", fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 700 }}>
                        {m.playerName ?? "—"}
                        {m.serialNumber != null && (
                          <span style={{ color: "var(--rpc-text-muted)", marginLeft: 6, fontFamily: "var(--font-mono)", fontSize: 10 }}>#{m.serialNumber}</span>
                        )}
                      </td>
                      <td style={{ padding: "8px 10px", color: "var(--rpc-text-secondary)" }}>{m.setName ?? "—"}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--rpc-text-primary)" }}>${m.currentFmvUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                      <td style={{ padding: "8px 10px" }}>
                        <span
                          style={{
                            display: "inline-block",
                            padding: "2px 8px",
                            borderRadius: 999,
                            fontSize: 9,
                            letterSpacing: "0.12em",
                            textTransform: "uppercase",
                            background: m.isLocked ? "rgba(52,211,153,0.1)" : "rgba(255,255,255,0.05)",
                            color: m.isLocked ? "var(--rpc-success)" : "var(--rpc-text-muted)",
                            border: `1px solid ${m.isLocked ? "rgba(52,211,153,0.3)" : "var(--rpc-border)"}`,
                          }}
                        >
                          {m.isLocked ? "Locked" : "Unlocked"}
                        </span>
                      </td>
                      <td style={{ padding: "8px 10px", textAlign: "right" }}>{m.estimatedPlayoffPoints.toLocaleString()}</td>
                      <td style={{ padding: "8px 10px", textAlign: "right", color: "var(--rpc-red)", fontWeight: 700 }}>
                        {m.pointsPerDollar.toFixed(3)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile card list — driven by @media in <style> below. */}
          <div className="rpc-rtr-card-list" style={{ display: "none", flexDirection: "column", gap: 8 }}>
            {sorted.map(m => {
              const accent = topAccentSet.has(m.momentId)
                ? "var(--rpc-success)"
                : bottomAccentSet.has(m.momentId)
                  ? "var(--rpc-danger)"
                  : "transparent"
              return (
                <div
                  key={m.momentId}
                  style={{
                    padding: 12,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid var(--rpc-border)",
                    borderLeft: `3px solid ${accent}`,
                    borderRadius: "var(--radius-md)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                    <div style={{ fontFamily: "'Barlow Condensed', sans-serif", fontWeight: 800, fontSize: 14, color: "var(--rpc-text-primary)" }}>
                      {m.playerName ?? "—"}
                      {m.serialNumber != null && <span style={{ color: "var(--rpc-text-muted)", marginLeft: 6, fontFamily: "var(--font-mono)", fontSize: 10 }}>#{m.serialNumber}</span>}
                    </div>
                    <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: "var(--rpc-red)" }}>{m.pointsPerDollar.toFixed(3)}</div>
                  </div>
                  <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 2 }}>{m.setName ?? "—"}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 8, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--rpc-text-secondary)" }}>
                    <span>FMV ${m.currentFmvUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    <span>· {m.estimatedPlayoffPoints.toLocaleString()} est pts</span>
                    <span>· {m.isLocked ? "Locked" : "Unlocked"}</span>
                  </div>
                </div>
              )
            })}
          </div>

          <style>{`
            @media (max-width: 640px) {
              .rpc-rtr-table-wrap { display: none !important; }
              .rpc-rtr-card-list { display: flex !important; }
            }
            @media (min-width: 641px) {
              .rpc-rtr-mobile-sort { display: none !important; }
            }
          `}</style>
        </>
      )}
    </div>
  )
}

function SortHeader({
  label,
  col,
  sortKey,
  sortDir,
  onClick,
  align = "left",
}: {
  label: string
  col: LockRoiSortKey
  sortKey: LockRoiSortKey
  sortDir: LockRoiSortDir
  onClick: (col: LockRoiSortKey) => void
  align?: "left" | "right"
}) {
  const active = col === sortKey
  return (
    <th
      onClick={() => onClick(col)}
      style={{
        padding: "8px 10px",
        cursor: "pointer",
        userSelect: "none",
        textAlign: align,
        color: active ? "var(--rpc-text-primary)" : undefined,
      }}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
    >
      {label}
      {active && <span style={{ marginLeft: 4 }}>{sortDir === "asc" ? "▲" : "▼"}</span>}
    </th>
  )
}
