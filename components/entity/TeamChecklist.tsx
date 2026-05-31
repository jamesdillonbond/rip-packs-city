"use client"

// components/entity/TeamChecklist.tsx
// Team Hub Phase 2 (C5). The differentiated centerpiece: a public, priced team
// checklist with three scopes (All-Time / Contemporary / per-Series), a
// cost-to-complete figure, and wallet-paste owned-vs-missing tracking.
//
// - Anonymous (no wallet): renders the FULL checklist + the public
//   cost-to-complete number. This is the indexable SEO surface — it must render
//   fully without a wallet.
// - Wallet-paste (no login): pasting a 0x Flow address adds owned/missing flags
//   from wallet_moments_cache. If the wallet isn't indexed yet, we fire the
//   EXISTING public wallet-search path (which warms wmc) and poll back, rather
//   than re-implementing backfill.
//
// Data: /api/entity/team-checklist (paginated tiles) +
//       /api/entity/team-checklist-progress (header + cost-to-complete).
// Brand tokens only (var(--rpc-*), var(--font-display)).

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { ConfidencePill, EM_DASH, TierBadge, fmtCount, fmtUsd } from "./_shared"
import type { EditionTile } from "./EditionsGridPaginated"
import { topshotSeriesLabel, TOPSHOT_SERIES_ORDER } from "@/lib/analytics/series-labels"

interface ChecklistTile extends EditionTile {
  owned?: boolean | null
  owned_count?: number | null
}

interface TierBreakdown {
  tier: string
  total: number
  owned: number
  cost_usd: number
}

interface Progress {
  total: number
  owned: number
  missing_count: number
  completion_pct: number | null
  cost_to_complete_usd: number
  stale_missing_pct: number | null
  wallet_cached: boolean
  scope: string
  by_tier: TierBreakdown[]
}

interface Props {
  collectionUrlSlug: string
  teamSlug: string
  /** Optional explicit series list. When omitted the component derives it from its first all_time fetch. */
  seriesOptions?: number[]
}

const PAGE_SIZE = 24
const WALLET_RE = /^0x[0-9a-f]{16}$/
const LS_KEY = "rpc_checklist_wallet"
const MAX_INDEX_POLLS = 6
const INDEX_POLL_MS = 12_000

type Scope = string // "all_time" | "contemporary" | "series_<n>"

function seriesChipLabel(collectionUrlSlug: string, n: number): string {
  if (collectionUrlSlug === "nba-top-shot") return topshotSeriesLabel(n)
  return `Series ${n}`
}

function isFlowAddr(v: string): boolean {
  const lower = v.trim().toLowerCase()
  return WALLET_RE.test(lower)
}

export default function TeamChecklist({ collectionUrlSlug, teamSlug, seriesOptions: seriesProp }: Props) {
  const isTopShot = collectionUrlSlug === "nba-top-shot"

  const [scope, setScope] = useState<Scope>("all_time")
  const [wallet, setWallet] = useState<string | null>(null)
  const [walletInput, setWalletInput] = useState("")
  const [walletError, setWalletError] = useState<string | null>(null)

  const [rows, setRows] = useState<ChecklistTile[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  const [seriesOptions, setSeriesOptions] = useState<number[]>(seriesProp ?? [])
  const [indexing, setIndexing] = useState(false)

  const reqIdRef = useRef(0)
  const indexFiredRef = useRef<Set<string>>(new Set())
  const pollCountRef = useRef(0)

  // Restore a previously-pasted wallet so it carries across team pages.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LS_KEY)
      if (saved && isFlowAddr(saved)) setWallet(saved.toLowerCase())
    } catch { /* localStorage unavailable */ }
  }, [])

  const checklistUrl = useCallback((s: Scope, w: string | null, offset: number) => {
    const p = new URLSearchParams({
      collection: collectionUrlSlug,
      slug: teamSlug,
      scope: s,
      offset: String(offset),
      limit: String(PAGE_SIZE),
    })
    if (w) p.set("wallet", w)
    return `/api/entity/team-checklist?${p.toString()}`
  }, [collectionUrlSlug, teamSlug])

  const progressUrl = useCallback((s: Scope, w: string | null) => {
    const p = new URLSearchParams({ collection: collectionUrlSlug, slug: teamSlug, scope: s })
    if (w) p.set("wallet", w)
    return `/api/entity/team-checklist-progress?${p.toString()}`
  }, [collectionUrlSlug, teamSlug])

  // Primary load (page 0) + progress for the active (scope, wallet).
  const loadScope = useCallback(async (s: Scope, w: string | null) => {
    const myReq = ++reqIdRef.current
    setLoading(true)
    try {
      const [cRes, pRes] = await Promise.all([
        fetch(checklistUrl(s, w, 0), { cache: "no-store" }),
        fetch(progressUrl(s, w), { cache: "no-store" }),
      ])
      const cJson: ChecklistTile[] = cRes.ok ? await cRes.json() : []
      const pJson: Progress | null = pRes.ok ? await pRes.json() : null
      if (myReq !== reqIdRef.current) return // a newer request superseded this one
      const safe = Array.isArray(cJson) ? cJson : []
      setRows(safe)
      setExhausted(safe.length < PAGE_SIZE)
      setProgress(pJson)

      // Derive series chips from the first all_time fetch (when not provided).
      if (s === "all_time" && (!seriesProp || seriesProp.length === 0)) {
        setSeriesOptions(prev => {
          if (prev.length > 0) return prev
          const seen = new Set<number>()
          for (const r of safe) {
            if (typeof r.series_num === "number") seen.add(r.series_num)
          }
          const arr = Array.from(seen)
          if (isTopShot) {
            return arr.sort((a, b) => TOPSHOT_SERIES_ORDER.indexOf(a) - TOPSHOT_SERIES_ORDER.indexOf(b))
          }
          return arr.sort((a, b) => b - a)
        })
      }
    } catch {
      if (myReq === reqIdRef.current) { setRows([]); setProgress(null); setExhausted(true) }
    } finally {
      if (myReq === reqIdRef.current) setLoading(false)
    }
  }, [checklistUrl, progressUrl, seriesProp, isTopShot])

  useEffect(() => { loadScope(scope, wallet) }, [scope, wallet, loadScope])

  // Indexing flow: a wallet that isn't cached yet → warm wmc via the existing
  // public wallet-search path (fire-once per wallet), then poll progress back.
  useEffect(() => {
    if (!wallet || !progress) { setIndexing(false); return }
    if (progress.wallet_cached) { setIndexing(false); pollCountRef.current = 0; return }

    setIndexing(true)
    // Fire the warm-up exactly once per wallet.
    if (!indexFiredRef.current.has(wallet)) {
      indexFiredRef.current.add(wallet)
      pollCountRef.current = 0
      void fetch("/api/wallet-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: wallet, offset: 0, limit: 50, collection: collectionUrlSlug }),
      }).catch(() => { /* fire-and-forget; polling will pick up the result */ })
    }
    if (pollCountRef.current >= MAX_INDEX_POLLS) return
    const id = window.setTimeout(() => {
      pollCountRef.current += 1
      loadScope(scope, wallet)
    }, INDEX_POLL_MS)
    return () => window.clearTimeout(id)
  }, [wallet, progress, scope, collectionUrlSlug, loadScope])

  async function loadMore() {
    if (loadingMore || exhausted || loading) return
    setLoadingMore(true)
    try {
      const r = await fetch(checklistUrl(scope, wallet, rows.length), { cache: "no-store" })
      const next: ChecklistTile[] = r.ok ? await r.json() : []
      const safe = Array.isArray(next) ? next : []
      setRows(prev => [...prev, ...safe])
      if (safe.length < PAGE_SIZE) setExhausted(true)
    } catch {
      setExhausted(true)
    } finally {
      setLoadingMore(false)
    }
  }

  function submitWallet(e: React.FormEvent) {
    e.preventDefault()
    const v = walletInput.trim().toLowerCase()
    if (!isFlowAddr(v)) { setWalletError("Enter a valid 0x Flow address (0x + 16 hex)."); return }
    setWalletError(null)
    setWallet(v)
    try { window.localStorage.setItem(LS_KEY, v) } catch { /* ignore */ }
  }

  function clearWallet() {
    setWallet(null)
    setWalletInput("")
    setWalletError(null)
    try { window.localStorage.removeItem(LS_KEY) } catch { /* ignore */ }
  }

  // ── Scope tabs ──────────────────────────────────────────────────────────────
  const scopeTabs: Array<{ key: Scope; label: string }> = [
    { key: "all_time", label: "All-Time" },
    // Contemporary = play season == series season; a Top Shot concept only.
    ...(isTopShot ? [{ key: "contemporary", label: "Contemporary" }] : []),
  ]

  const pct = progress?.completion_pct ?? 0
  const hasWallet = !!wallet
  const staleNote = progress && progress.stale_missing_pct != null && progress.stale_missing_pct >= 15

  return (
    <div>
      {/* ── Scope tabs + series chips ─────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {scopeTabs.map(t => (
          <ScopeChip key={t.key} active={scope === t.key} onClick={() => setScope(t.key)}>{t.label}</ScopeChip>
        ))}
        {seriesOptions.map(n => {
          const key = `series_${n}`
          return (
            <ScopeChip key={key} active={scope === key} onClick={() => setScope(key)}>
              {seriesChipLabel(collectionUrlSlug, n)}
            </ScopeChip>
          )
        })}
      </div>

      {/* ── Progress header ───────────────────────────────────────────────── */}
      {progress && progress.total > 0 && (
        <div className="rpc-card" style={{ padding: 16, marginBottom: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <div className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
                {hasWallet ? "Owned" : "Checklist"}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>
                {hasWallet ? `${fmtCount(progress.owned)} / ${fmtCount(progress.total)}` : `${fmtCount(progress.total)} editions`}
                {hasWallet && (
                  <span className="rpc-mono" style={{ fontSize: 13, color: "var(--rpc-red)", marginLeft: 8 }}>{pct}%</span>
                )}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
                {hasWallet ? "Cost to complete" : "Cost to complete at floor"}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>
                {fmtUsd(progress.cost_to_complete_usd)}
              </div>
            </div>
          </div>

          {/* completion bar */}
          <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
            <div style={{
              width: `${Math.max(0, Math.min(100, pct))}%`,
              height: "100%",
              background: "var(--rpc-red)",
              transition: "width 200ms ease",
            }} />
          </div>

          {/* per-tier breakdown */}
          {progress.by_tier && progress.by_tier.length > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {progress.by_tier.map(t => (
                <div key={t.tier} className="rpc-mono" style={{
                  display: "flex", alignItems: "center", gap: 6, fontSize: 10,
                  padding: "4px 8px", borderRadius: 4,
                  border: "1px solid rgba(255,255,255,0.10)", color: "var(--rpc-text-secondary)",
                }}>
                  <TierBadge tier={t.tier} />
                  <span>{hasWallet ? `${t.owned}/${t.total}` : `${t.total}`}</span>
                  {t.cost_usd > 0 && <span style={{ color: "var(--rpc-text-muted)" }}>{fmtUsd(t.cost_usd)}</span>}
                </div>
              ))}
            </div>
          )}

          {staleNote && (
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
              {progress!.stale_missing_pct}% of missing editions have stale or low-confidence pricing — cost-to-complete is an at-floor estimate, not a quote.
            </div>
          )}
        </div>
      )}

      {/* ── Wallet-paste / track ──────────────────────────────────────────── */}
      <div className="rpc-card" style={{ padding: 14, marginBottom: 14 }}>
        {!hasWallet ? (
          <form onSubmit={submitWallet} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
              Paste your wallet to see what you&rsquo;re missing:
            </span>
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              value={walletInput}
              onChange={e => setWalletInput(e.target.value)}
              style={{
                flex: "1 1 220px", minWidth: 180, padding: "8px 10px", borderRadius: 6,
                background: "var(--rpc-surface)", border: "1px solid rgba(255,255,255,0.14)",
                color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: 12,
              }}
            />
            <button type="submit" className="rpc-btn-ghost">Track</button>
          </form>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
              Tracking <span style={{ color: "var(--rpc-text-primary)" }}>{wallet!.slice(0, 6)}…{wallet!.slice(-4)}</span>
            </span>
            <button type="button" className="rpc-btn-ghost" onClick={clearWallet}>Clear</button>
          </div>
        )}
        {walletError && <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-red)", marginTop: 6 }}>{walletError}</div>}
        {indexing && (
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 8 }}>
            Indexing your collection — check back shortly. This can take a minute on first paste.
          </div>
        )}
      </div>

      {/* ── Tiles ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading checklist…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>No editions for this scope.</div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {rows.map((e, idx) => (
              <ChecklistCard key={`${e.route_slug}-${idx}`} collectionUrlSlug={collectionUrlSlug} e={e} hasWallet={hasWallet} eager={idx < 12} />
            ))}
          </div>
          {!exhausted && (
            <div style={{ marginTop: 14, display: "flex", justifyContent: "center" }}>
              <button type="button" className="rpc-btn-ghost" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} more`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Scope chip ────────────────────────────────────────────────────────────────
function ScopeChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rpc-chip"
      style={{
        background: active ? "var(--rpc-red-bg)" : undefined,
        borderColor: active ? "var(--rpc-red-border)" : undefined,
        color: active ? "var(--rpc-red)" : undefined,
        cursor: "pointer",
      }}
    >{children}</button>
  )
}

// ── Checklist tile (mirrors EditionsGridPaginated styling + ownership badge) ───
function ChecklistCard({ collectionUrlSlug, e, hasWallet, eager }: { collectionUrlSlug: string; e: ChecklistTile; hasWallet: boolean; eager: boolean }) {
  const owned = e.owned === true
  const addCost = e.floor_usd ?? e.fmv_usd ?? null
  // Missing tiles are dimmed slightly so owned pops against them.
  const dim = hasWallet && !owned

  return (
    <Link
      href={`/${collectionUrlSlug}/edition/${encodeURIComponent(e.route_slug)}`}
      className="rpc-card"
      style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block", opacity: dim ? 0.82 : 1, position: "relative" }}
    >
      <div style={{ position: "relative", aspectRatio: "1 / 1", minHeight: 150, background: "rgba(0,0,0,0.35)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
        {e.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={e.thumbnail_url}
            alt={e.player_name ?? e.name ?? "Edition"}
            width={200}
            height={200}
            loading={eager ? "eager" : "lazy"}
            decoding={eager ? "sync" : "async"}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", filter: dim ? "grayscale(0.35)" : undefined }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>No image</div>
        )}
        {/* ownership badge — only when a wallet is tracked */}
        {hasWallet && (
          <div style={{
            position: "absolute", top: 6, right: 6, padding: "3px 7px", borderRadius: 999,
            fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.04em",
            background: owned ? "rgba(52,211,153,0.16)" : "rgba(0,0,0,0.62)",
            border: owned ? "1px solid rgba(52,211,153,0.45)" : "1px solid rgba(255,255,255,0.18)",
            color: owned ? "#34D399" : "var(--rpc-text-primary)",
          }}>
            {owned ? `✓${e.owned_count && e.owned_count > 1 ? ` ×${e.owned_count}` : ""}` : (addCost ? `+ ${fmtUsd(addCost)}` : "+ add")}
          </div>
        )}
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
        {e.player_name ?? e.name ?? "Edition"}
      </div>
      {e.set_name && (
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", marginBottom: 6 }}>{e.set_name}</div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <TierBadge tier={e.tier} />
        {e.series_label && <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{e.series_label}</span>}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>FMV</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 15, color: "var(--rpc-text-primary)" }}>{fmtUsd(e.fmv_usd)}</div>
        </div>
        <ConfidencePill confidence={e.fmv_confidence ?? null} />
      </div>
      <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end" }}>
        <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
          Mint {e.circulation_count != null ? fmtCount(e.circulation_count) : EM_DASH}
        </span>
      </div>
    </Link>
  )
}
