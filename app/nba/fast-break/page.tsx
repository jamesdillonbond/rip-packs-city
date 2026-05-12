"use client"

// app/nba/fast-break/page.tsx
//
// Public NBA Top Shot Fast Break lineup optimizer. Anyone (signed-in or not)
// can hit the page and see the optimal daily lineup. Phase 1 — no wallet
// integration; Phase 2 will layer in ownership constraint via
// fast_break_player_uses.
//
// Anatomy, top to bottom:
//   1. Hero band (display H1 + mono subtitle + active-run badge)
//   2. Horizontal date-picker pill row (yesterday / today / next 3 days)
//   3. Recommended lineup card (player rows + total)
//   4. Reasoning row (1-line per player)
//   5. Educational footer + external link
//
// Date picker pills are horizontally scrollable on mobile (touch-friendly,
// no wrap). Selected pill fills red; others outlined.

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { pickEmpty } from "@/lib/schonely"

type LineupPlayer = {
  nba_player_id: string
  full_name: string
  team_abbr: string | null
  position: string | null
  proj_fp_dk: number | null
  projected_with_captain: number | null
  is_captain: boolean
  headshot_url: string | null
  opponent_abbr: string | null
  tipoff_at: string | null
  injury_status: string | null
  confidence: string | null
  rank: number
}

type OptimizeResponse = {
  recommended_score: number
  lineup: LineupPlayer[]
  meta: {
    run_id?: string
    run_name?: string
    run_start_date?: string
    run_end_date?: string
    run_is_active?: boolean
    game_date: string
    lineup_size?: number
    has_captain?: boolean
    objective?: string
    eligible_players_pool_size?: number
    no_active_run?: boolean
  }
  as_of?: string
  error?: string
}

function todayEastern(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

function addDaysISO(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + delta)
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt)
}

function fmtPillLabel(iso: string): { weekday: string; mdy: string } {
  const [y, m, d] = iso.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" })
    .format(dt)
    .toUpperCase()
  const mdy = `${m}/${d}`
  return { weekday, mdy }
}

function fmtTipoff(iso: string | null): string {
  if (!iso) return ""
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso))
  } catch {
    return ""
  }
}

function injuryTone(status: string | null): { label: string; color: string } | null {
  if (!status) return null
  const u = status.toUpperCase()
  if (u === "ACTIVE" || u === "HEALTHY") return null
  if (u === "PROBABLE") return { label: "PROBABLE", color: "var(--rpc-warning)" }
  if (u === "GTD") return { label: "GTD", color: "var(--rpc-warning)" }
  return { label: u, color: "var(--rpc-warning)" }
}

function Initials({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(s => s[0])
    .join("")
    .toUpperCase()
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: "50%",
        background: "var(--rpc-surface)",
        border: "1px solid var(--rpc-border)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--rpc-text-primary)",
        fontFamily: "var(--font-display)",
        fontWeight: 800,
        fontSize: 16,
        letterSpacing: "0.04em",
        flexShrink: 0,
      }}
      aria-hidden
    >
      {initials || "?"}
    </div>
  )
}

export default function FastBreakPage() {
  const today = useMemo(() => todayEastern(), [])
  const pillDates = useMemo(
    () => [addDaysISO(today, -1), today, addDaysISO(today, 1), addDaysISO(today, 2), addDaysISO(today, 3)],
    [today]
  )

  const [selected, setSelected] = useState<string>(today)
  const [data, setData] = useState<OptimizeResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [emptyHook] = useState(() => pickEmpty())

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/nba/fast-break/optimize?game_date=${encodeURIComponent(selected)}`)
      .then(r => r.ok ? r.json() : r.json().then((j: any) => Promise.reject(new Error(j?.error ?? `HTTP ${r.status}`))))
      .then((j: OptimizeResponse) => {
        if (cancelled) return
        setData(j)
      })
      .catch(e => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selected])

  const lineup = data?.lineup ?? []
  const meta = data?.meta
  const score = data?.recommended_score ?? 0

  return (
    <div style={{ minHeight: "100vh", background: "var(--rpc-black)", color: "var(--rpc-text-primary)" }}>
      <FastBreakHeader />

      <main style={{ maxWidth: 980, margin: "0 auto", padding: "32px 16px 64px", display: "flex", flexDirection: "column", gap: 24 }}>

        {/* ── Hero band ── */}
        <section style={{ textAlign: "center", padding: "16px 0 8px" }}>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              letterSpacing: "0.3em",
              textTransform: "uppercase",
              color: "var(--rpc-red)",
              marginBottom: 12,
            }}
          >
            ◈ NBA TOP SHOT ◈ FAST BREAK ◈
          </div>
          <h1
            style={{
              fontFamily: "var(--font-display)",
              fontWeight: 900,
              fontSize: "clamp(36px, 8vw, 64px)",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              lineHeight: 1.02,
              color: "var(--rpc-text-primary)",
              margin: 0,
            }}
          >
            FAST BREAK OPTIMIZER
          </h1>
          <div
            style={{
              marginTop: 12,
              fontFamily: "var(--font-mono)",
              fontSize: 13,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--rpc-text-muted)",
            }}
          >
            Optimal NBA Top Shot Fast Break lineups · updated every 15 min
          </div>

          {meta?.run_name && (
            <div
              style={{
                marginTop: 18,
                display: "inline-flex",
                alignItems: "center",
                gap: 10,
                padding: "6px 14px",
                background: meta.run_is_active ? "var(--rpc-red-bg)" : "var(--rpc-surface-raised)",
                border: "1px solid " + (meta.run_is_active ? "var(--rpc-red-border)" : "var(--rpc-border)"),
                borderRadius: 999,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: meta.run_is_active ? "var(--rpc-red)" : "var(--rpc-text-muted)",
              }}
            >
              {meta.run_is_active && (
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "var(--rpc-red)",
                    animation: "pulse 2s infinite",
                  }}
                />
              )}
              <span>{meta.run_name}</span>
              {meta.run_end_date && (
                <>
                  <span style={{ opacity: 0.6 }}>·</span>
                  <span>
                    {meta.run_is_active ? "Ends" : "From"}{" "}
                    {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(
                      new Date(meta.run_end_date + "T00:00:00Z")
                    )}
                  </span>
                </>
              )}
            </div>
          )}
        </section>

        {/* ── Date picker strip ── */}
        <section
          aria-label="Choose game date"
          style={{
            display: "flex",
            gap: 10,
            overflowX: "auto",
            padding: "4px 2px 8px",
            scrollSnapType: "x mandatory",
          }}
          className="rpc-fb-pills"
        >
          {pillDates.map(iso => {
            const isSelected = iso === selected
            const isToday = iso === today
            const { weekday, mdy } = fmtPillLabel(iso)
            return (
              <button
                key={iso}
                type="button"
                onClick={() => setSelected(iso)}
                aria-pressed={isSelected}
                style={{
                  flexShrink: 0,
                  scrollSnapAlign: "start",
                  minWidth: 116,
                  padding: "10px 14px",
                  background: isSelected ? "var(--rpc-red)" : "var(--rpc-surface-raised)",
                  border: "1px solid " + (isSelected ? "var(--rpc-red)" : "var(--rpc-border)"),
                  borderRadius: 8,
                  color: isSelected ? "#fff" : "var(--rpc-text-primary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <div style={{ opacity: 0.7, fontSize: 10 }}>
                  {weekday} · {mdy}
                </div>
                <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 16, marginTop: 4, letterSpacing: "0.04em" }}>
                  {isToday ? "TODAY" : weekday}
                </div>
              </button>
            )
          })}
        </section>

        {/* ── Recommended lineup card ── */}
        <section
          className="rpc-card"
          style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 16 }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <div
                className="rpc-label"
                style={{ fontFamily: "var(--font-display)", color: "var(--rpc-text-primary)" }}
              >
                Recommended Lineup
              </div>
              {meta?.eligible_players_pool_size !== undefined && (
                <div
                  className="rpc-mono"
                  style={{ marginTop: 4, fontSize: "var(--text-xs)", color: "var(--rpc-text-muted)" }}
                >
                  {meta.eligible_players_pool_size} eligible projections in pool
                </div>
              )}
            </div>
            <div style={{ textAlign: "right" }}>
              <div
                className="rpc-mono"
                style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}
              >
                Total Projected
              </div>
              <div
                style={{
                  fontFamily: "var(--font-display)",
                  fontWeight: 900,
                  fontSize: "clamp(28px, 6vw, 44px)",
                  color: "var(--rpc-red)",
                  lineHeight: 1,
                  letterSpacing: "0.02em",
                }}
              >
                {score.toFixed(2)} FP
              </div>
            </div>
          </div>

          {error ? (
            <div className="rpc-mono" style={{ color: "var(--rpc-danger)", padding: "12px 0" }}>
              Couldn&rsquo;t load the optimizer right now. Please refresh in a minute.
            </div>
          ) : loading ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[0, 1, 2].map(i => (
                <div
                  key={i}
                  className="rpc-skeleton"
                  style={{ width: "100%", height: 76, borderRadius: "var(--radius-sm)" }}
                />
              ))}
            </div>
          ) : meta?.no_active_run ? (
            <div
              className="rpc-mono"
              style={{ color: "var(--rpc-text-muted)", padding: "24px 0", textAlign: "center", lineHeight: 1.6 }}
            >
              {emptyHook}
              <br />
              No Fast Break run is currently active. Check back when the next run launches.
            </div>
          ) : lineup.length === 0 ? (
            <div
              className="rpc-mono"
              style={{ color: "var(--rpc-text-muted)", padding: "24px 0", textAlign: "center", lineHeight: 1.6 }}
            >
              {emptyHook}
              <br />
              No NBA games on {selected}. Try another date.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {lineup.map(p => {
                const injury = injuryTone(p.injury_status)
                return (
                  <div
                    key={p.nba_player_id}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "auto 1fr auto",
                      gap: 14,
                      alignItems: "center",
                      padding: "12px 14px",
                      background: "var(--rpc-surface-raised)",
                      border: "1px solid var(--rpc-border)",
                      borderLeft: p.is_captain ? "3px solid var(--rpc-red)" : "1px solid var(--rpc-border)",
                      borderRadius: "var(--radius-sm)",
                    }}
                  >
                    {p.headshot_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={p.headshot_url}
                        alt={p.full_name}
                        width={48}
                        height={48}
                        style={{ borderRadius: "50%", flexShrink: 0, objectFit: "cover", background: "var(--rpc-surface)" }}
                      />
                    ) : (
                      <Initials name={p.full_name} />
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 8,
                          flexWrap: "wrap",
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--font-display)",
                            fontWeight: 800,
                            fontSize: 18,
                            letterSpacing: "0.02em",
                            color: "var(--rpc-text-primary)",
                          }}
                        >
                          {p.full_name}
                        </span>
                        {p.is_captain && (
                          <span
                            className="rpc-mono"
                            style={{
                              fontSize: 9,
                              letterSpacing: "0.18em",
                              textTransform: "uppercase",
                              padding: "2px 8px",
                              borderRadius: 999,
                              background: "var(--rpc-red-bg)",
                              border: "1px solid var(--rpc-red-border)",
                              color: "var(--rpc-red)",
                              fontWeight: 700,
                            }}
                          >
                            Captain · 1.5×
                          </span>
                        )}
                        {injury && (
                          <span
                            className="rpc-mono"
                            style={{
                              fontSize: 9,
                              letterSpacing: "0.18em",
                              textTransform: "uppercase",
                              padding: "2px 8px",
                              borderRadius: 999,
                              border: "1px solid var(--rpc-warning)",
                              color: "var(--rpc-warning)",
                              fontWeight: 700,
                            }}
                          >
                            {injury.label}
                          </span>
                        )}
                      </div>
                      <div
                        className="rpc-mono"
                        style={{ marginTop: 4, fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.06em" }}
                      >
                        {[p.team_abbr, p.position].filter(Boolean).join(" · ")}
                        {p.opponent_abbr ? ` · vs ${p.opponent_abbr}` : ""}
                        {p.tipoff_at ? ` · ${fmtTipoff(p.tipoff_at)} ET` : ""}
                      </div>
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily: "var(--font-mono)",
                        color: p.is_captain ? "var(--rpc-red)" : "var(--rpc-text-primary)",
                      }}
                    >
                      <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: "0.02em" }}>
                        {p.projected_with_captain != null ? p.projected_with_captain.toFixed(2) : "—"} FP
                      </div>
                      {p.is_captain && p.proj_fp_dk != null && (
                        <div style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
                          base {p.proj_fp_dk.toFixed(2)}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Reasoning row ── */}
        {lineup.length > 0 && !loading && !error && (
          <section
            className="rpc-card"
            style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 10 }}
          >
            <div className="rpc-label" style={{ fontFamily: "var(--font-display)", color: "var(--rpc-text-primary)" }}>
              Why these picks
            </div>
            {lineup.map(p => (
              <div
                key={p.nba_player_id}
                className="rpc-mono"
                style={{ fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.6 }}
              >
                <span style={{ color: "var(--rpc-text-primary)", fontWeight: 700 }}>{p.full_name}</span>{" "}
                ({p.team_abbr ?? "—"}
                {p.opponent_abbr ? ` vs ${p.opponent_abbr}` : ""}) projects{" "}
                <span style={{ color: "var(--rpc-text-primary)" }}>
                  {p.proj_fp_dk != null ? p.proj_fp_dk.toFixed(2) : "—"} FP
                </span>
                {p.is_captain ? " — highest projection in slate, designated captain." : "."}
              </div>
            ))}
          </section>
        )}

        {/* ── Educational footer ── */}
        <section
          className="rpc-card"
          style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 12 }}
        >
          <div className="rpc-label" style={{ fontFamily: "var(--font-display)", color: "var(--rpc-text-primary)" }}>
            How Fast Break works
          </div>
          <p
            className="rpc-mono"
            style={{ fontSize: 12, color: "var(--rpc-text-secondary)", lineHeight: 1.7, margin: 0 }}
          >
            NBA Top Shot Fast Break is a daily lineup game where you pick {meta?.lineup_size ?? 3} NBA players whose
            real fantasy-points totals are summed for that night&rsquo;s slate. {meta?.has_captain ? "One player is designated as a 1.5× captain — their score is multiplied before totaling. " : ""}
            We rank every eligible projection from DraftKings (filtering out OUT / QUESTIONABLE players) by projected
            fantasy points and surface the optimal {meta?.lineup_size ?? 3}-man lineup for that night.
          </p>
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", letterSpacing: "0.04em" }}>
            Updated every 15 minutes from live projections.{" "}
            <a
              href="https://nbatopshot.com/fastbreak"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--rpc-red)", textDecoration: "underline" }}
            >
              Official Fast Break page →
            </a>
          </div>
        </section>

        <div
          style={{
            textAlign: "center",
            paddingTop: 12,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--rpc-text-muted)",
          }}
        >
          <Link href="/" style={{ color: "var(--rpc-text-muted)", textDecoration: "underline" }}>
            ← Back to Rip Packs City
          </Link>
        </div>

      </main>

      <style jsx global>{`
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.4; }
          100% { opacity: 1; }
        }
        .rpc-fb-pills::-webkit-scrollbar { display: none; }
        .rpc-fb-pills { scrollbar-width: none; }
      `}</style>
    </div>
  )
}

function FastBreakHeader() {
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "rgba(8,8,8,0.85)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderBottom: "1px solid var(--rpc-border)",
      }}
    >
      <div
        style={{
          maxWidth: 1100,
          margin: "0 auto",
          padding: "0 16px",
          height: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Link
          href="/"
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 900,
            fontSize: 16,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--rpc-text-primary)",
            textDecoration: "none",
          }}
        >
          RIP PACKS <span style={{ color: "var(--rpc-red)" }}>CITY</span>
        </Link>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            letterSpacing: "0.18em",
            textTransform: "uppercase",
            color: "var(--rpc-text-muted)",
          }}
        >
          / NBA / FAST BREAK
        </span>
        <div style={{ flex: 1 }} />
        <Link
          href="/nba-top-shot/overview"
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: "var(--rpc-text-secondary)",
            textDecoration: "none",
          }}
        >
          Top Shot tools →
        </Link>
      </div>
    </header>
  )
}
