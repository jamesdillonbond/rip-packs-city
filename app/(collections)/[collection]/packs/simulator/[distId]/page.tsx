"use client"

// app/(collections)/[collection]/packs/simulator/[distId]/page.tsx
//
// Pack rip simulator. Calls /api/pack-simulator on mount, then samples
// client-side from pool[].drop_weight via cumulative-weight binary search.
// Three rip buttons (1 / 10 / 100) animate per-card flips and accumulate
// aggregate stats. The disclaimer footer explains how this differs from the
// canonical trimmed-mean pack_ev shown on the listing page.

import { useCallback, useEffect, useMemo, useState, use } from "react"
import Link from "next/link"
import { COLLECTION_UUID_BY_SLUG, getCollection } from "@/lib/collections"

interface PackInfo {
  dist_id: string
  title: string | null
  image_url: string | null
  pack_type: string | null
  tier: string | null
  slots: number | null
  retail_price_usd: number | null
  total_minted: number | null
  total_opened: number | null
  total_sealed: number | null
  depletion_pct: number | null
}

interface PoolEdition {
  edition_id: string
  edition_slug: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  thumbnail_url: string | null
  drop_weight: number
  hit_probability: number
  fmv_usd: number | null
  floor_price_usd: number | null
  fmv_confidence: string | null
}

interface SimulatorMetrics {
  edition_count_pullable: number
  editions_with_fmv: number | null
  fmv_coverage_pct: number | null
  max_pull_fmv: number | null
  max_pull_player: string | null
  max_pull_set: string | null
  max_pull_tier: string | null
  max_pull_thumbnail: string | null
  grails_25: number
  grails_100: number
  grails_500: number
  grails_1000: number
  ultimate_count: number
  legendary_count: number
  rare_count: number
  weighting_method: string
  ev_per_slot: number
  prob_grail_25_per_slot: number
  prob_grail_100_per_slot: number
  prob_grail_500_per_slot: number
  prob_grail_1000_per_slot: number
  prob_ultimate_per_slot: number
  prob_legendary_per_slot: number
  weighted_pool_value: number | null
  weighted_grail_value_100plus: number | null
}

interface SimulatorPayload {
  pack: PackInfo
  pool: PoolEdition[]
  metrics: SimulatorMetrics
  note?: string
  computed_at?: string
  error?: string
}

interface RipResult {
  rips: PullResult[][]
  aggregate: AggregateStats
}

interface PullResult {
  edition: PoolEdition
  ripIndex: number
}

interface AggregateStats {
  totalRips: number
  totalSlots: number
  // How many of `totalSlots` pulled an edition with a real FMV. Slots without
  // FMV count $0 in `totalValue` and `packValues` — surfacing the coverage
  // ratio lets the UI honestly say "X/Y pulls had FMV" instead of pretending
  // the totals are complete (Pack audit B3).
  fmvCoveredSlots: number
  totalValue: number
  packValues: number[]
  maxPackValue: number
  ripsBeatRetail: number
  retail: number | null
  hitCounts: Record<string, number>
}

const THRESHOLDS: Array<{ key: string; label: string; min: number }> = [
  { key: "$25+", label: "$25+", min: 25 },
  { key: "$100+", label: "$100+", min: 100 },
  { key: "$500+", label: "$500+", min: 500 },
  { key: "$1000+", label: "$1000+", min: 1000 },
]

function tierColor(tier: string | null | undefined): string {
  const t = (tier || "").toLowerCase()
  if (t.includes("ultimate")) return "#EC4899"
  if (t.includes("legendary")) return "#F59E0B"
  if (t.includes("rare")) return "#818CF8"
  if (t.includes("fandom")) return "#34D399"
  if (t.includes("common")) return "#9CA3AF"
  if (t.includes("premium")) return "#A855F7"
  if (t.includes("standard")) return "#6B7280"
  if (t.includes("challenger")) return "#EF4444"
  if (t.includes("contender")) return "#F59E0B"
  return "#6B7280"
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "—"
  const v = Number(n)
  if (Math.abs(v) >= 1000) return "$" + Math.round(v).toLocaleString("en-US")
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(Number(p))) return "—"
  const v = Number(p) * 100
  return v.toFixed(v < 1 ? 2 : 1) + "%"
}

// Build a cumulative-weight array from pool[i].drop_weight. Used once per
// rip session; sampleEdition does a binary search across this CDF in O(log n).
function buildCdf(pool: PoolEdition[]): { cdf: number[]; total: number } {
  const cdf: number[] = new Array(pool.length)
  let running = 0
  for (let i = 0; i < pool.length; i++) {
    const w = Number(pool[i].drop_weight) || 0
    running += w > 0 ? w : 0
    cdf[i] = running
  }
  return { cdf, total: running }
}

function sampleEdition(pool: PoolEdition[], cdf: number[], total: number): PoolEdition {
  if (total <= 0 || pool.length === 0) return pool[0]
  const r = Math.random() * total
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cdf[mid] < r) lo = mid + 1
    else hi = mid
  }
  return pool[lo]
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

interface PageProps {
  params: Promise<{ collection: string; distId: string }>
}

export default function PackSimulatorPage({ params }: PageProps) {
  const { collection: collectionSlug, distId } = use(params)
  const collectionObj = getCollection(collectionSlug)
  const collectionUuid = COLLECTION_UUID_BY_SLUG[collectionSlug] ?? null
  const accent = collectionObj?.accent ?? "var(--rpc-red)"

  const [payload, setPayload] = useState<SimulatorPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [slotsOverride, setSlotsOverride] = useState<number | null>(null)
  const [slotsApprox, setSlotsApprox] = useState(false)

  const [ripping, setRipping] = useState(false)
  const [result, setResult] = useState<RipResult | null>(null)
  const [flipIndex, setFlipIndex] = useState(0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!collectionUuid) {
        setError("Unknown collection: " + collectionSlug)
        setLoading(false)
        return
      }
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(
          `/api/pack-simulator?collectionId=${encodeURIComponent(collectionUuid)}&distId=${encodeURIComponent(distId)}`,
          { cache: "no-store" },
        )
        const json = (await res.json()) as SimulatorPayload
        if (cancelled) return
        if (!res.ok || json.error || !json.pack || !json.pool) {
          setPayload(json)
        } else {
          setPayload(json)
          // /api/pack-ev requires `packListingId` and returns no `momentsPerPack` /
          // `slots` field, so the previous fallback path here was dead for 100% of
          // NFL/UFC/Pinnacle/Golazos packs (Pack audit B1). Go straight to the
          // 5-slot approximation when the dist doesn't carry a real slot count.
          if (json.pack.slots == null) {
            setSlotsOverride(5)
            setSlotsApprox(true)
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [collectionUuid, collectionSlug, distId])

  const slots = payload?.pack?.slots ?? slotsOverride ?? null
  const retail = payload?.pack?.retail_price_usd != null ? Number(payload.pack.retail_price_usd) : null

  const sampler = useMemo(() => {
    if (!payload?.pool || payload.pool.length === 0) return null
    return buildCdf(payload.pool)
  }, [payload])

  const runRips = useCallback(
    async (n: number) => {
      if (!payload?.pool || !sampler || !slots || slots <= 0) return
      setRipping(true)
      setFlipIndex(0)
      const rips: PullResult[][] = []
      const packValues: number[] = []
      let totalValue = 0
      let maxPackValue = 0
      let ripsBeatRetail = 0
      const hitCounts: Record<string, number> = {
        "$25+": 0, "$100+": 0, "$500+": 0, "$1000+": 0, ultimate: 0, legendary: 0,
      }
      let fmvCoveredSlots = 0
      for (let i = 0; i < n; i++) {
        const pulls: PullResult[] = []
        let packVal = 0
        for (let s = 0; s < slots; s++) {
          const edition = sampleEdition(payload.pool, sampler.cdf, sampler.total)
          pulls.push({ edition, ripIndex: s })
          const hasFmv = edition.fmv_usd != null && Number.isFinite(Number(edition.fmv_usd))
          const fmv = hasFmv ? Number(edition.fmv_usd) : 0
          if (hasFmv) fmvCoveredSlots++
          packVal += fmv
          for (const t of THRESHOLDS) if (fmv >= t.min) hitCounts[t.key]++
          const tier = (edition.tier || "").toLowerCase()
          if (tier.includes("ultimate")) hitCounts.ultimate++
          else if (tier.includes("legendary")) hitCounts.legendary++
        }
        rips.push(pulls)
        packValues.push(packVal)
        totalValue += packVal
        if (packVal > maxPackValue) maxPackValue = packVal
        if (retail != null && packVal > retail) ripsBeatRetail++
      }
      setResult({
        rips,
        aggregate: {
          totalRips: n,
          totalSlots: n * slots,
          fmvCoveredSlots,
          totalValue,
          packValues,
          maxPackValue,
          ripsBeatRetail,
          retail,
          hitCounts,
        },
      })
      // Animate flips for single-rip (most dramatic) and short-pack 10x runs.
      if (n <= 10) {
        for (let i = 0; i < rips.length * slots; i++) {
          await new Promise((r) => setTimeout(r, 70))
          setFlipIndex((p) => p + 1)
        }
      } else {
        setFlipIndex(rips.length * slots)
      }
      setRipping(false)
    },
    [payload, sampler, slots, retail],
  )

  if (loading) {
    return (
      <div style={{ minHeight: 400, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        Loading pack simulator…
      </div>
    )
  }

  if (error || !payload || payload.error || !payload.pack || !payload.pool || payload.pool.length === 0) {
    return (
      <div style={{ maxWidth: 640, margin: "40px auto", padding: 24, border: "1px solid var(--rpc-border, #27272a)", borderRadius: 10, background: "var(--rpc-surface, #0d0d0d)", textAlign: "center" }}>
        <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800, color: "#fff", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 12 }}>
          Drop pool not indexed
        </div>
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.6, color: "rgba(255,255,255,0.65)" }}>
          This pack&apos;s drop pool isn&apos;t indexed — usually because it&apos;s sold out and being secondary-traded.
          The simulator works on packs with an indexed drop pool.
        </div>
        <div style={{ marginTop: 18 }}>
          <Link href={`/${collectionSlug}/packs`} style={{ display: "inline-block", padding: "8px 16px", background: accent, color: "#fff", borderRadius: 6, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 12, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
            Back to packs
          </Link>
        </div>
      </div>
    )
  }

  const pack = payload.pack
  const metrics = payload.metrics

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 18px 80px" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800;900&family=Share+Tech+Mono&display=swap');
        .rpc-sim-stat { font-family: var(--font-mono); }
        .rpc-sim-header { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.06em; }
        .rpc-sim-button { transition: transform 120ms ease, background 120ms ease; cursor: pointer; }
        .rpc-sim-button:hover:not(:disabled) { transform: translateY(-1px); }
        .rpc-sim-button:disabled { opacity: 0.45; cursor: not-allowed; }
        .rpc-pull-card { animation: rpc-pull-flip 240ms cubic-bezier(.2,.7,.3,1); transform-origin: center; }
        @keyframes rpc-pull-flip {
          0%   { transform: rotateY(90deg) scale(0.85); opacity: 0; }
          60%  { transform: rotateY(0deg) scale(1.04); opacity: 1; }
          100% { transform: rotateY(0deg) scale(1); opacity: 1; }
        }
      `}</style>

      {/* Hero */}
      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap", padding: "14px 0 18px", borderBottom: `1px solid ${accent}33` }}>
        <div style={{ flexShrink: 0, width: 160, aspectRatio: "5 / 7", background: "#0d0d0d", border: `1px solid ${accent}55`, borderRadius: 8, overflow: "hidden", boxShadow: "0 8px 24px rgba(0,0,0,0.4)" }}>
          {pack.image_url ? (
            <img src={pack.image_url} alt={pack.title ?? "Pack"} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          ) : (
            <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "rgba(255,255,255,0.3)", fontSize: 48 }}>?</div>
          )}
        </div>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div className="rpc-sim-stat" style={{ fontSize: 10, color: accent, letterSpacing: "0.14em", marginBottom: 4 }}>
            PACK RIP SIMULATOR · {collectionObj?.label ?? collectionSlug}
          </div>
          <h1 className="rpc-sim-header" style={{ fontSize: 30, fontWeight: 900, color: "#fff", margin: 0, lineHeight: 1.05 }}>
            {pack.title ?? `Pack #${pack.dist_id}`}
          </h1>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 10 }}>
            <Stat label="Retail" value={fmtUsd(retail)} accent={accent} />
            <Stat label="Slots / Pack" value={slots != null ? String(slots) + (slotsApprox ? " ~" : "") : "—"} accent={accent} />
            <Stat label="EV / Slot" value={fmtUsd(metrics.ev_per_slot)} accent={accent} />
            <Stat label="Pool" value={`${metrics.edition_count_pullable} editions`} accent={accent} />
            <Stat label="FMV cov." value={metrics.fmv_coverage_pct != null ? metrics.fmv_coverage_pct + "%" : "—"} accent={accent} />
            <Stat label="Depletion" value={pack.depletion_pct != null ? pack.depletion_pct + "%" : "—"} accent={accent} />
          </div>
          {metrics.max_pull_fmv != null && (
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: `${accent}11`, border: `1px solid ${accent}55`, borderRadius: 6 }}>
              {metrics.max_pull_thumbnail && <img src={metrics.max_pull_thumbnail} alt="" style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, border: `1px solid ${tierColor(metrics.max_pull_tier)}` }} />}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="rpc-sim-stat" style={{ fontSize: 10, color: accent, letterSpacing: "0.12em" }}>CHASE</div>
                <div className="rpc-sim-header" style={{ fontSize: 14, fontWeight: 800, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {metrics.max_pull_player ?? "—"} · {(metrics.max_pull_tier ?? "").replace(/_/g, " ")}
                </div>
              </div>
              <div className="rpc-sim-stat" style={{ fontSize: 18, fontWeight: 700, color: "#fff" }}>{fmtUsd(metrics.max_pull_fmv)}</div>
            </div>
          )}
        </div>
      </div>

      {/* Grail probabilities */}
      <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8 }}>
        <ProbCard label="P(any $25+) per slot" prob={metrics.prob_grail_25_per_slot} accent={accent} count={metrics.grails_25} />
        <ProbCard label="P(any $100+) per slot" prob={metrics.prob_grail_100_per_slot} accent={accent} count={metrics.grails_100} />
        <ProbCard label="P(any $500+) per slot" prob={metrics.prob_grail_500_per_slot} accent={accent} count={metrics.grails_500} />
        <ProbCard label="P($1000+) per slot" prob={metrics.prob_grail_1000_per_slot} accent={accent} count={metrics.grails_1000} />
        <ProbCard label="P(Ultimate) per slot" prob={metrics.prob_ultimate_per_slot} accent={accent} count={metrics.ultimate_count} />
        <ProbCard label="P(Legendary) per slot" prob={metrics.prob_legendary_per_slot} accent={accent} count={metrics.legendary_count} />
      </div>

      {/* Rip buttons */}
      <div style={{ marginTop: 22, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <RipButton disabled={ripping || !slots} onClick={() => runRips(1)} accent={accent} label="Rip 1 Pack" />
        <RipButton disabled={ripping || !slots} onClick={() => runRips(10)} accent={accent} label="Rip 10" />
        <RipButton disabled={ripping || !slots} onClick={() => runRips(100)} accent={accent} label="Rip 100" />
        {result && (
          <button onClick={() => { setResult(null); setFlipIndex(0) }} className="rpc-sim-button" style={{ padding: "10px 16px", background: "transparent", color: "rgba(255,255,255,0.7)", border: "1px solid #444", borderRadius: 6, fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 12, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Reset
          </button>
        )}
      </div>

      {/* Aggregate */}
      {result && (
        <AggregateCard result={result} accent={accent} />
      )}

      {/* Pulls */}
      {result && (
        <PullsGrid result={result} accent={accent} flipIndex={flipIndex} slots={slots ?? 1} />
      )}

      {/* Disclaimer */}
      <div style={{ marginTop: 32, padding: "12px 14px", borderTop: "1px solid #27272a", color: "rgba(255,255,255,0.5)", fontFamily: "var(--font-mono)", fontSize: 11, lineHeight: 1.7 }}>
        Simulation uses stored drop weights from when the pack was indexed; real pack odds shift slightly as packs are opened. EV per slot here uses weighted sampling (metrics.ev_per_slot); the canonical trimmed-mean pack EV shown on the pack listing page may differ.
        {payload.note && <div style={{ marginTop: 6, opacity: 0.8 }}>{payload.note}</div>}
        {payload.computed_at && <div style={{ marginTop: 4, opacity: 0.7 }}>Pool computed: {new Date(payload.computed_at).toLocaleString()}</div>}
      </div>
    </div>
  )
}

// ── Subcomponents ───────────────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: accent, letterSpacing: "0.12em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 18, fontWeight: 700, color: "#fff" }}>{value}</div>
    </div>
  )
}

function ProbCard({ label, prob, accent, count }: { label: string; prob: number | null | undefined; accent: string; count: number | null | undefined }) {
  return (
    <div style={{ padding: "10px 12px", background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 6 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.55)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 800, color: "#fff", marginTop: 2 }}>{fmtPct(prob)}</div>
      {count != null && <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: accent, marginTop: 1 }}>{count} editions</div>}
    </div>
  )
}

function RipButton({ onClick, label, accent, disabled }: { onClick: () => void; label: string; accent: string; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rpc-sim-button"
      style={{ padding: "12px 22px", background: accent, color: "#fff", border: "none", borderRadius: 6, fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 14, letterSpacing: "0.12em", textTransform: "uppercase" }}
    >
      {label}
    </button>
  )
}

function AggregateCard({ result, accent }: { result: RipResult; accent: string }) {
  const a = result.aggregate
  const avg = a.totalRips > 0 ? a.totalValue / a.totalRips : 0
  const sd = stddev(a.packValues)
  const beatPct = a.retail != null && a.totalRips > 0 ? (a.ripsBeatRetail / a.totalRips) * 100 : null
  // FMV coverage: slots without an FMV count $0 in totalValue, so values are
  // biased low when coverage is partial — surface the ratio honestly.
  const fmvCovPct = a.totalSlots > 0 ? (a.fmvCoveredSlots / a.totalSlots) * 100 : null
  const fmvCovPartial = fmvCovPct != null && fmvCovPct < 99.5
  return (
    <div style={{ marginTop: 18, padding: 14, background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8 }}>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 800, color: accent, letterSpacing: "0.14em", textTransform: "uppercase", marginBottom: 10 }}>
        Aggregate · {a.totalRips} rip{a.totalRips === 1 ? "" : "s"} · {a.totalSlots} slots
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 10 }}>
        <Metric label="Avg pack value" value={fmtUsd(avg)} accent={accent} />
        <Metric label="Max pack value" value={fmtUsd(a.maxPackValue)} accent={accent} />
        <Metric label="Std dev" value={fmtUsd(sd)} accent={accent} />
        {beatPct != null && <Metric label="% beat retail" value={beatPct.toFixed(1) + "%"} accent={beatPct >= 50 ? "#34D399" : accent} />}
        <Metric label="Total pulled" value={fmtUsd(a.totalValue)} accent={accent} />
      </div>
      {fmvCovPartial && (
        <div style={{ marginTop: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "rgba(255,255,255,0.55)", lineHeight: 1.5 }}>
          {a.fmvCoveredSlots} / {a.totalSlots} pulls had FMV ({fmvCovPct?.toFixed(1)}%). Slots without FMV
          are counted as $0, so values above (incl. % beat retail) are a lower bound.
        </div>
      )}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
        {THRESHOLDS.map((t) => {
          const hits = a.hitCounts[t.key] ?? 0
          const rate = a.totalSlots > 0 ? (hits / a.totalSlots) * 100 : 0
          return (
            <HitMetric key={t.key} label={t.label} hits={hits} rate={rate} />
          )
        })}
        <HitMetric label="Ultimate" hits={a.hitCounts.ultimate ?? 0} rate={a.totalSlots > 0 ? ((a.hitCounts.ultimate ?? 0) / a.totalSlots) * 100 : 0} />
        <HitMetric label="Legendary" hits={a.hitCounts.legendary ?? 0} rate={a.totalSlots > 0 ? ((a.hitCounts.legendary ?? 0) / a.totalSlots) * 100 : 0} />
      </div>
    </div>
  )
}

function Metric({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 20, fontWeight: 800, color: accent }}>{value}</div>
    </div>
  )
}

function HitMetric({ label, hits, rate }: { label: string; hits: number; rate: number }) {
  return (
    <div style={{ background: "#080808", border: "1px solid #1f1f22", padding: "6px 10px", borderRadius: 4 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "rgba(255,255,255,0.5)", letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-display)", fontSize: 16, fontWeight: 700, color: "#fff" }}>{hits} <span style={{ fontSize: 10, color: "rgba(255,255,255,0.55)" }}>({rate.toFixed(2)}%)</span></div>
    </div>
  )
}

function PullsGrid({ result, accent, flipIndex, slots }: { result: RipResult; accent: string; flipIndex: number; slots: number }) {
  let runningCount = 0
  return (
    <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
      {result.rips.map((pulls, ri) => {
        const packValue = pulls.reduce((s, p) => s + (p.edition.fmv_usd != null ? Number(p.edition.fmv_usd) : 0), 0)
        return (
          <div key={ri} style={{ background: "#0d0d0d", border: "1px solid #27272a", borderRadius: 8, padding: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontFamily: "var(--font-display)", fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", color: accent, textTransform: "uppercase" }}>
                Rip #{ri + 1}
              </div>
              <div style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "#fff" }}>
                {fmtUsd(packValue)}
                {result.aggregate.retail != null && (
                  <span style={{ marginLeft: 8, color: packValue >= result.aggregate.retail ? "#34D399" : "#F87171", fontSize: 11 }}>
                    {packValue >= result.aggregate.retail ? "+" : "-"}{fmtUsd(Math.abs(packValue - result.aggregate.retail))}
                  </span>
                )}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(90px, 1fr))", gap: 6 }}>
              {pulls.map((pull, si) => {
                const idx = runningCount++
                const visible = idx < flipIndex
                if (!visible && flipIndex < result.aggregate.totalSlots) {
                  return (
                    <div key={si} style={{ aspectRatio: "5 / 7", background: "#080808", border: "1px solid #27272a", borderRadius: 4 }} />
                  )
                }
                const tier = pull.edition.tier ?? "common"
                return (
                  <div key={si} className="rpc-pull-card" style={{ background: "#080808", border: `2px solid ${tierColor(tier)}`, borderRadius: 4, overflow: "hidden", display: "flex", flexDirection: "column" }}>
                    {pull.edition.thumbnail_url ? (
                      <img src={pull.edition.thumbnail_url} alt={pull.edition.player_name ?? "Pulled moment"} style={{ width: "100%", aspectRatio: "1 / 1", objectFit: "cover" }} />
                    ) : (
                      <div style={{ width: "100%", aspectRatio: "1 / 1", background: "#0d0d0d" }} />
                    )}
                    <div style={{ padding: "4px 5px" }}>
                      <div style={{ fontFamily: "var(--font-display)", fontSize: 11, fontWeight: 700, color: "#fff", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {pull.edition.player_name ?? "—"}
                      </div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: tierColor(tier), textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {(tier || "").replace(/_/g, " ")}
                      </div>
                      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#fff", marginTop: 1 }}>
                        {fmtUsd(pull.edition.fmv_usd)}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      {/* keep slots param referenced so React doesn't tree-shake the prop */}
      <div style={{ display: "none" }}>{slots}</div>
    </div>
  )
}
