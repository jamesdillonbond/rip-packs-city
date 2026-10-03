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
// - A SOLANA collection (Candy MLB, 2026-09-25) takes a base58 key VERBATIM —
//   never lowercased, it is case-sensitive — in its own localStorage slot, via
//   lib/entity/checklist-wallet.ts (shared with the routes). There is no
//   warm-on-paste for it: /api/wallet-search is a Flow path, and Candy holdings
//   are cached by a scheduled walk. So an uncached key says exactly that,
//   instead of an "Indexing…" banner that nothing would ever satisfy.
// - Signed in (2026-09-28): the profile's linked wallet is tracked automatically
//   and silently — no paste box, no "tracking your wallet" line (2026-09-29). A wallet pasted
//   earlier (localStorage) still wins; Clear falls back to the profile wallet.
//   The profile wallet is Flow, so it only applies where it parses for this
//   collection's chain (never on a Solana checklist). A degraded identity read
//   leaves walletAddr unknown, so the paste box stays — never a false "yours".
//
// - View toggle (Trevor, 2026-09-30; concierge feature request 09-29): "All
//   moments" (every edition and subedition parallel, the default) vs "Full
//   editions", which reads the checklist at the full-edition level — parallels
//   are removed from view, and owned / % / cost-to-complete count full editions;
//   owning ANY parallel checks its full edition off (Trevor, 09-30). Shown only when the collection's data carries parallel editions
//   (probe, not a slug list). Persisted as ?view=full so it is shareable (the
//   09-29 ?parallels=exclude link still opens it).
//
// - Reader filters (webz, 2026-10-01): the per-tier chips are toggles — a hidden
//   tier leaves the tiles AND the header (owned / % / cost-to-complete), e.g.
//   "no chance I can collect all the Ultimates". Remembered per collection in
//   localStorage. With a wallet, the owned+locked / owned / missing legend is a
//   toggle too ("view only the ones I'm missing"). Any filter reads the COMPLETE
//   list (the full-editions route, ?view=all in "All moments") and filters and
//   re-totals it locally — a filtered header over a 24-row page would be false.
//
// Data: /api/entity/team-checklist (paginated tiles) +
//       /api/entity/team-checklist-progress (header + cost-to-complete);
//       "Full editions" reads /api/entity/team-checklist-full-editions (whole
//       filtered list + header; lib/entity/checklist-full-editions.ts).
// Brand tokens only (var(--rpc-*), var(--font-display)).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { EM_DASH, TierBadge, fmtCount, fmtUsd, tileSubject } from "./_shared"
import type { EditionTile } from "./EditionsGridPaginated"
import { topshotSeriesLabel, TOPSHOT_SERIES_ORDER } from "@/lib/analytics/series-labels"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { getCollection, collectionHasLocking } from "@/lib/collections"
import { checklistWalletStorageKey, isSolanaChecklist, parseChecklistWallet } from "@/lib/entity/checklist-wallet"
import { editionRouteHref } from "@/lib/entity-href"
import { useSessionOwner } from "@/lib/hooks/useSessionOwner"
import {
  CHECKLIST_OWN_STATES,
  computeFullEditionProgress,
  filterChecklistTiles,
  parseChecklistView,
  parseHiddenTiers,
  tierKey,
  type ChecklistOwnState,
  type ChecklistView,
} from "@/lib/entity/checklist-full-editions"

interface ChecklistTile extends EditionTile {
  owned?: boolean | null
  owned_count?: number | null
  // Team Hub polish (P2): per-wallet lock state from wmc.is_locked. Drives the
  // green (owned+locked) vs white (owned) tile parity with Top Shot. Null when
  // no wallet is tracked.
  owned_locked?: boolean | null
  // "Full editions" view only: this edition's price (floor, else FMV), null when
  // it has neither — see lib/entity/checklist-full-editions.ts.
  edition_cost_usd?: number | null
  // "Full editions" view only: parallels of this edition the wallet holds —
  // any one of them checks the edition off (Trevor, 2026-09-30).
  owned_parallels?: number | null
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
  // Team Hub polish (P2): owned editions that are locked. Powers the "X locked"
  // readout next to the owned count.
  locked_owned?: number | null
  missing_count: number
  completion_pct: number | null
  cost_to_complete_usd: number
  stale_missing_pct: number | null
  wallet_cached: boolean
  scope: string
  by_tier: TierBreakdown[]
  // "Full editions" view only: missing editions with no price, which are NOT in
  // cost_to_complete_usd (never counted as $0).
  unpriced_missing_count?: number
}

interface FullEditionsResponse {
  has_parallels: boolean
  progress: Progress
  // Full editions only: the RPC edition rows with parallels removed.
  editions: ChecklistTile[]
}

interface Props {
  collectionUrlSlug: string
  teamSlug: string
  /** Optional explicit series list. When omitted the component derives it from its first all_time fetch. */
  seriesOptions?: number[]
}

const PAGE_SIZE = 24
const VIEW_LS_KEY = "rpc:team-checklist:view"  // per collection: a choice on Top Shot must not follow the reader to a collection without parallels
const HIDDEN_TIERS_LS_KEY = "rpc:team-checklist:hidden-tiers"  // per collection: tier vocabularies differ
const MAX_INDEX_POLLS = 6
const INDEX_POLL_MS = 12_000

type Scope = string // "all_time" | "contemporary" | "series_<n>"

function seriesChipLabel(collectionUrlSlug: string, n: number): string {
  if (collectionUrlSlug === "nba-top-shot") return topshotSeriesLabel(n)
  return `Series ${n}`
}

export default function TeamChecklist({ collectionUrlSlug, teamSlug, seriesOptions: seriesProp }: Props) {
  const isTopShot = collectionUrlSlug === "nba-top-shot"
  // Disney Pinnacle pins cannot be locked: no "N locked", no locked legend or state.
  const hasLocking = collectionHasLocking(collectionUrlSlug)
  const dbChain = getCollection(collectionUrlSlug)?.dbChain ?? null
  const isSolana = isSolanaChecklist(dbChain)
  const lsKey = checklistWalletStorageKey(dbChain)

  const [scope, setScope] = useState<Scope>("all_time")
  const [wallet, setWallet] = useState<string | null>(null)
  const [walletInput, setWalletInput] = useState("")
  const [walletError, setWalletError] = useState<string | null>(null)

  const [rows, setRows] = useState<ChecklistTile[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exhausted, setExhausted] = useState(false)
  // A failed READ, distinct from an empty result. rows === [] is produced by
  // both, and the two mean opposite things on a checklist: "this team has no
  // editions in this scope" vs "we could not ask".
  const [failed, setFailed] = useState(false)
  // A failed PAGE load. The base list is intact and correct; it is just short.
  // Silently truncating a checklist is worse than blanking it, because every
  // tile on screen still looks right.
  const [pageFailed, setPageFailed] = useState(false)
  const [seriesOptions, setSeriesOptions] = useState<number[]>(seriesProp ?? [])
  const [indexing, setIndexing] = useState(false)
  const [mode, setMode] = useState<ChecklistView>("all")
  const [modeReady, setModeReady] = useState(false)
  // Does this collection carry parallel editions at all? null = not known (probe
  // pending or failed) — the toggle then shows only if the URL already asks for it.
  const [collectionHasParallels, setCollectionHasParallels] = useState<boolean | null>(null)
  // "Full editions" — and any reader filter — reads the whole scoped list at
  // once and pages it locally. completeFor names the read it holds, so a
  // filtered header is never re-totalled from another scope's / wallet's list.
  const [allFull, setAllFull] = useState<ChecklistTile[]>([])
  const [completeFor, setCompleteFor] = useState<string | null>(null)
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [hiddenTiers, setHiddenTiers] = useState<string[]>([])
  const [shownStates, setShownStates] = useState<ChecklistOwnState[]>([...CHECKLIST_OWN_STATES])

  const session = useSessionOwner()
  const ownParsed = session.walletAddr ? parseChecklistWallet(session.walletAddr, dbChain) : null
  const ownWallet = ownParsed?.ok ? ownParsed.wallet : null

  const reqIdRef = useRef(0)
  const indexFiredRef = useRef<Set<string>>(new Set())
  const pollCountRef = useRef(0)

  // View: the URL wins (a shared link), then this viewer's last choice.
  useEffect(() => {
    try {
      const q = new URLSearchParams(window.location.search)
      const view = q.get("view")
      const legacy = q.get("parallels")
      if (view != null || legacy != null) setMode(parseChecklistView(view, legacy))
      else setMode(parseChecklistView(window.localStorage.getItem(`${VIEW_LS_KEY}:${collectionUrlSlug}`)))
    } catch { /* URL/localStorage unavailable — stay on "all" */ }
    // The first load waits for this, so a shared ?view=full link does not first
    // fetch (and flash) the all-moments view.
    setModeReady(true)
  }, [collectionUrlSlug])

  // Whether to offer the toggle is a property of the data, not of the slug.
  useEffect(() => {
    let cancelled = false
    const p = new URLSearchParams({ collection: collectionUrlSlug, probe: "1" })
    fetch(`/api/entity/team-checklist-full-editions?${p.toString()}`, { cache: "no-store" })
      .then(async r => {
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled && j && typeof j.has_parallels === "boolean") setCollectionHasParallels(j.has_parallels)
      })
      .catch(() => { /* unknown: the toggle stays hidden unless the URL asked for it */ })
    return () => { cancelled = true }
  }, [collectionUrlSlug])

  useEffect(() => {
    try { setHiddenTiers(parseHiddenTiers(window.localStorage.getItem(`${HIDDEN_TIERS_LS_KEY}:${collectionUrlSlug}`))) }
    catch { /* localStorage unavailable — nothing hidden */ }
  }, [collectionUrlSlug])

  function toggleTier(tier: string) {
    setHiddenTiers(prev => {
      const next = prev.includes(tier) ? prev.filter(t => t !== tier) : [...prev, tier]
      try {
        const k = `${HIDDEN_TIERS_LS_KEY}:${collectionUrlSlug}`
        if (next.length > 0) window.localStorage.setItem(k, JSON.stringify(next))
        else window.localStorage.removeItem(k)
      } catch { /* ignore */ }
      return next
    })
    setVisible(PAGE_SIZE)
  }

  function showAllTiers() {
    setHiddenTiers([])
    try { window.localStorage.removeItem(`${HIDDEN_TIERS_LS_KEY}:${collectionUrlSlug}`) } catch { /* ignore */ }
    setVisible(PAGE_SIZE)
  }

  function toggleOwnState(st: ChecklistOwnState) {
    setShownStates(prev => prev.includes(st) ? prev.filter(x => x !== st) : [...prev, st])
    setVisible(PAGE_SIZE)
  }

  function changeMode(next: ChecklistView) {
    setMode(next)
    try {
      const u = new URL(window.location.href)
      u.searchParams.delete("parallels")
      if (next === "full") u.searchParams.set("view", "full")
      else u.searchParams.delete("view")
      window.history.replaceState(window.history.state, "", u.toString())
    } catch { /* ignore */ }
    try { window.localStorage.setItem(`${VIEW_LS_KEY}:${collectionUrlSlug}`, next) } catch { /* ignore */ }
  }

  // Restore a previously-pasted wallet so it carries across team pages.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(lsKey)
      const parsed = saved ? parseChecklistWallet(saved, dbChain) : null
      if (parsed?.ok && parsed.wallet) setWallet(parsed.wallet)
    } catch { /* localStorage unavailable */ }
  }, [lsKey, dbChain])

  // Signed in with a linked wallet and nothing pasted → track the reader's own.
  useEffect(() => {
    if (!ownWallet) return
    let saved: string | null = null
    try { saved = window.localStorage.getItem(lsKey) } catch { /* localStorage unavailable */ }
    if (saved && parseChecklistWallet(saved, dbChain).ok) return
    setWallet(prev => prev ?? ownWallet)
  }, [ownWallet, lsKey, dbChain])

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

  const fullUrl = useCallback((s: Scope, w: string | null, m: ChecklistView) => {
    const p = new URLSearchParams({ collection: collectionUrlSlug, slug: teamSlug, scope: s })
    if (w) p.set("wallet", w)
    // "All moments" with a filter on: the complete list, ungrouped.
    if (m === "all") p.set("view", "all")
    return `/api/entity/team-checklist-full-editions?${p.toString()}`
  }, [collectionUrlSlug, teamSlug])

  const deriveSeries = useCallback((s: Scope, safe: ChecklistTile[]) => {
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
  }, [seriesProp, isTopShot])

  // Primary load (page 0) + progress for the active (scope, wallet, mode).
  // `complete`: read the whole scoped list ("Full editions", or a filter is on).
  const loadScope = useCallback(async (s: Scope, w: string | null, m: ChecklistView, complete: boolean) => {
    const myReq = ++reqIdRef.current
    setLoading(true)
    if (complete) {
      // ONE read feeds both the header and the tiles here, so it gates both: a
      // failed read shows the failure state, never a "0 editions / $0" header.
      setCompleteFor(null)
      try {
        const r = await fetch(fullUrl(s, w, m), { cache: "no-store" })
        const j: FullEditionsResponse | null = r.ok ? await r.json() : null
        if (myReq !== reqIdRef.current) return
        const ok = !!j && Array.isArray(j.editions) && !!j.progress
        const eds = ok ? j!.editions : []
        setFailed(!ok)
        setPageFailed(false)
        setAllFull(eds)
        setCompleteFor(ok ? `${s}|${w ?? ""}|${m}` : null)
        setVisible(PAGE_SIZE)
        setProgress(ok ? j!.progress : null)
        if (ok) deriveSeries(s, eds)
      } catch {
        if (myReq === reqIdRef.current) { setFailed(true); setAllFull([]); setProgress(null) }
      } finally {
        if (myReq === reqIdRef.current) setLoading(false)
      }
      return
    }
    try {
      const [cRes, pRes] = await Promise.all([
        fetch(checklistUrl(s, w, 0), { cache: "no-store" }),
        fetch(progressUrl(s, w), { cache: "no-store" }),
      ])
      const cJson: ChecklistTile[] = cRes.ok ? await cRes.json() : []
      const pJson: Progress | null = pRes.ok ? await pRes.json() : null
      if (myReq !== reqIdRef.current) return // a newer request superseded this one
      const safe = Array.isArray(cJson) ? cJson : []
      // Only the checklist read gates the honest-failure state. Progress is a
      // supplementary overlay — losing it degrades the tiles, it does not make
      // the catalogue unknown.
      setFailed(!cRes.ok)
      setPageFailed(false)
      setRows(safe)
      setExhausted(safe.length < PAGE_SIZE)
      setProgress(pJson)
      deriveSeries(s, safe)
    } catch {
      if (myReq === reqIdRef.current) { setFailed(true); setRows([]); setProgress(null); setExhausted(true) }
    } finally {
      if (myReq === reqIdRef.current) setLoading(false)
    }
  }, [checklistUrl, progressUrl, fullUrl, deriveSeries])

  // A filter is "on" only where it can change something: ownership filters need
  // a wallet, and "locked" exists only where the collection has locking.
  const relevantStates = CHECKLIST_OWN_STATES.filter(st => hasLocking || st !== "locked")
  const ownFilterOn = !!wallet && relevantStates.some(st => !shownStates.includes(st))
  const tierFilterOn = hiddenTiers.length > 0
  const completeMode = mode === "full" || tierFilterOn || ownFilterOn

  useEffect(() => {
    if (!modeReady) return
    loadScope(scope, wallet, mode, completeMode)
  }, [scope, wallet, mode, modeReady, completeMode, loadScope])

  // Indexing flow: a wallet that isn't cached yet → warm wmc via the existing
  // public wallet-search path (fire-once per wallet), then poll progress back.
  useEffect(() => {
    if (!wallet || !progress) { setIndexing(false); return }
    if (progress.wallet_cached) { setIndexing(false); pollCountRef.current = 0; return }
    // No warm path exists for a Solana key (see the header) — never claim one.
    if (isSolana) { setIndexing(false); return }

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
    // Polls exhausted: stop claiming "indexing". Without clearing the flag the
    // banner (a no-exit terminal state — this effect only re-runs on wallet /
    // scope / progress change, and none happen once polling stops) rendered the
    // "Indexing your collection — check back shortly" message forever, even after
    // the wallet finished warming, until a manual page reload.
    if (pollCountRef.current >= MAX_INDEX_POLLS) { setIndexing(false); return }
    const id = window.setTimeout(() => {
      pollCountRef.current += 1
      loadScope(scope, wallet, mode, completeMode)
    }, INDEX_POLL_MS)
    return () => window.clearTimeout(id)
  }, [wallet, progress, scope, mode, completeMode, collectionUrlSlug, loadScope, isSolana])

  async function loadMore() {
    if (loadingMore || shownExhausted || loading) return
    if (completeMode) {
      // The whole list is already here — reveal the next slice.
      setVisible(visible + PAGE_SIZE)
      return
    }
    setLoadingMore(true)
    try {
      const r = await fetch(checklistUrl(scope, wallet, rows.length), { cache: "no-store" })
      if (!r.ok) {
        // Do NOT set exhausted here. That both asserts the list is complete and
        // removes the only control that could retry it, so a single 500 freezes
        // a partial catalogue on screen permanently.
        setPageFailed(true)
        return
      }
      const next: ChecklistTile[] = await r.json()
      const safe = Array.isArray(next) ? next : []
      setPageFailed(false)
      setRows(prev => [...prev, ...safe])
      if (safe.length < PAGE_SIZE) setExhausted(true)
    } catch {
      setPageFailed(true)
    } finally {
      setLoadingMore(false)
    }
  }

  function submitWallet(e: React.FormEvent) {
    e.preventDefault()
    const parsed = parseChecklistWallet(walletInput, dbChain)
    if (!parsed.ok) { setWalletError(parsed.error); return }
    if (!parsed.wallet) {
      setWalletError(isSolana ? "Enter a Solana wallet address." : "Enter a valid 0x Flow address (0x + 16 hex).")
      return
    }
    const v = parsed.wallet
    setWalletError(null)
    setWallet(v)
    try {
      // Tracking your own wallet needs no saved slot — it follows the session.
      if (v === ownWallet) window.localStorage.removeItem(lsKey)
      else window.localStorage.setItem(lsKey, v)
    } catch { /* ignore */ }
  }

  function clearWallet() {
    // Falls back to the signed-in reader's own wallet when there is one.
    setWallet(ownWallet)
    setWalletInput("")
    setWalletError(null)
    try { window.localStorage.removeItem(lsKey) } catch { /* ignore */ }
  }

  // ── Scope tabs ──────────────────────────────────────────────────────────────
  const scopeTabs: Array<{ key: Scope; label: string }> = [
    { key: "all_time", label: "All-Time" },
    // Contemporary = play season == series season; a Top Shot concept only.
    ...(isTopShot ? [{ key: "contemporary", label: "Contemporary" }] : []),
  ]

  const hasWallet = !!wallet
  const hiddenSet = useMemo(() => new Set(hiddenTiers), [hiddenTiers])
  const loadedKey = `${scope}|${wallet ?? ""}|${mode}`
  const completeReady = completeMode && completeFor === loadedKey
  const filteredAll = useMemo(
    () => completeMode
      ? filterChecklistTiles(allFull, { hiddenTiers: hiddenSet, shownStates: ownFilterOn ? new Set(shownStates) : null, hasLocking })
      : [],
    [completeMode, allFull, hiddenSet, ownFilterOn, shownStates, hasLocking],
  )
  const shownRows = completeMode ? filteredAll.slice(0, visible) : rows
  const shownExhausted = completeMode ? visible >= filteredAll.length : exhausted
  // The header re-totalled without the hidden tiers. The tier chips keep the
  // unfiltered breakdown, so a hidden tier stays on screen to turn back on.
  // Ownership filters change only the tiles: the header is still the checklist.
  const header: Progress | null = useMemo(() => {
    if (!progress || !tierFilterOn || !completeReady) return progress
    const kept = allFull.filter(t => !hiddenSet.has(tierKey(t.tier)))
    return { ...progress, ...computeFullEditionProgress(kept, hasWallet), by_tier: progress.by_tier }
  }, [progress, tierFilterOn, completeReady, allFull, hiddenSet, hasWallet])
  // First toggle in "All moments": the complete list is still loading, so the
  // numbers on screen are not yet filtered — dim them rather than imply they are.
  const headerPending = tierFilterOn && !completeReady
  const pct = header?.completion_pct ?? 0
  const trackingOwn = hasWallet && wallet === ownWallet
  // Signed-in readers: hold the paste box until the session resolves, so it
  // does not flash and then vanish once their own wallet is picked up.
  const hidePasteWhileResolving = !hasWallet && session.loading
  // Your own wallet is ASSUMED, never announced (Trevor 2026-09-29: "should be
  // assumed and is just extra noise"). No card at all — except while a first
  // index is warming, when the status line is the only honest thing to show.
  const hideWalletCard = hidePasteWhileResolving || (trackingOwn && !indexing && !walletError)
  const staleNote = header && header.stale_missing_pct != null && header.stale_missing_pct >= 15
  const fullView = mode === "full"
  const unit = "editions"
  const unpricedMissing = header?.unpriced_missing_count ?? 0
  const hiddenLabel = progress?.by_tier.filter(t => hiddenSet.has(tierKey(t.tier))).map(t => tierLabel(t.tier)) ?? []
  // Offer the switch when the data has parallels — and always once a link has
  // turned it on, so the reader can turn it back off.
  const showViewToggle = collectionHasParallels === true || fullView

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

      {/* ── View toggle: all moments vs full editions ─────────────────────── */}
      {showViewToggle && (
        <div role="group" aria-label="Checklist view" style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <ScopeChip active={!fullView} onClick={() => changeMode("all")}>All moments</ScopeChip>
          <ScopeChip active={fullView} onClick={() => changeMode("full")}>Full editions</ScopeChip>
          {fullView && (
            <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
              Parallels hidden — owning any parallel checks off its edition.
            </span>
          )}
        </div>
      )}

      {/* ── Progress header ───────────────────────────────────────────────── */}
      {progress && header && progress.total > 0 && (
        <div className="rpc-card" aria-busy={headerPending || undefined} style={{ padding: 16, marginBottom: 14, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, opacity: headerPending ? 0.45 : 1, transition: "opacity 150ms ease" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, alignItems: "flex-end", justifyContent: "space-between" }}>
            <div>
              <div className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
                {hasWallet ? "Owned" : "Checklist"}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>
                {hasWallet ? `${fmtCount(header.owned)} / ${fmtCount(header.total)}` : `${fmtCount(header.total)} ${unit}`}
                {hasWallet && (
                  <span className="rpc-mono" style={{ fontSize: 13, color: "var(--rpc-red)", marginLeft: 8 }}>{pct}%</span>
                )}
              </div>
              {hasWallet && hasLocking && header.locked_owned != null && (
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 2 }}>
                  {fmtCount(header.locked_owned)} locked
                </div>
              )}
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="rpc-mono" style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "var(--rpc-text-muted)" }}>
                {hasWallet ? "Est. cost to complete" : "Est. cost to complete (all)"}
              </div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: 24, color: "var(--rpc-text-primary)", lineHeight: 1.1 }}>
                {fmtUsd(header.cost_to_complete_usd)}
              </div>
              {unpricedMissing > 0 && (
                <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", marginTop: 2 }}>
                  + {fmtCount(unpricedMissing)} unpriced {unpricedMissing === 1 ? "edition" : "editions"} not included
                </div>
              )}
            </div>
          </div>

          {/* completion bar */}
          <div style={{ height: 8, borderRadius: 999, background: "var(--rpc-surface-hover)", overflow: "hidden" }}>
            <div style={{
              width: `${Math.max(0, Math.min(100, pct))}%`,
              height: "100%",
              background: "var(--rpc-red)",
              transition: "width 200ms ease",
            }} />
          </div>

          </div>

          {/* per-tier breakdown — each chip toggles its tier in/out of the checklist */}
          {progress.by_tier && progress.by_tier.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div role="group" aria-label="Tiers in this checklist" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {progress.by_tier.map(t => {
                  const key = tierKey(t.tier)
                  const hidden = hiddenSet.has(key)
                  return (
                    <button
                      key={key}
                      type="button"
                      aria-pressed={!hidden}
                      title={hidden ? `Add ${tierLabel(t.tier)} back to the checklist` : `Leave ${tierLabel(t.tier)} out of the checklist`}
                      onClick={() => toggleTier(key)}
                      className="rpc-mono"
                      style={{
                        display: "flex", alignItems: "center", gap: 6, fontSize: 10,
                        padding: "4px 8px", borderRadius: 4, cursor: "pointer",
                        background: "transparent", font: "inherit",
                        border: hidden ? "1px dashed var(--rpc-border)" : "1px solid var(--rpc-border)",
                        color: "var(--rpc-text-secondary)",
                        opacity: hidden ? 0.45 : 1,
                        textDecoration: hidden ? "line-through" : undefined,
                      }}
                    >
                      <TierBadge tier={t.tier} />
                      <span>{hasWallet ? `${t.owned}/${t.total}` : `${t.total}`}</span>
                      {t.cost_usd > 0 && <span style={{ color: "var(--rpc-text-muted)" }}>{fmtUsd(t.cost_usd)}</span>}
                    </button>
                  )
                })}
              </div>
              <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {hiddenLabel.length > 0 ? (
                  <>
                    <span>Excluding {hiddenLabel.join(", ")} from the totals above.</span>
                    <button type="button" className="rpc-mono" onClick={showAllTiers}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 10, color: "var(--rpc-red)" }}>
                      Show all tiers
                    </button>
                  </>
                ) : (
                  <span>Tap a tier to leave it out of the checklist.</span>
                )}
              </div>
            </div>
          )}

          {staleNote && (
            <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
              {header.stale_missing_pct}% of missing {unit} have stale or low-confidence pricing — cost-to-complete is an estimate from recent lows and FMV, not a quote.
            </div>
          )}
        </div>
      )}

      {/* ── Wallet-paste / track ──────────────────────────────────────────── */}
      {!hideWalletCard && (
      <div className="rpc-card" style={{ padding: 14, marginBottom: 14 }}>
        {trackingOwn ? null : !hasWallet ? (
          <form onSubmit={submitWallet} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <span className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-secondary)" }}>
              Paste your wallet to see what you&rsquo;re missing:
            </span>
            <input
              type="text"
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              placeholder={isSolana ? "Solana wallet…" : "0x…"}
              value={walletInput}
              onChange={e => setWalletInput(e.target.value)}
              style={{
                flex: "1 1 220px", minWidth: 180, padding: "8px 10px", borderRadius: 6,
                background: "var(--rpc-surface)", border: "1px solid var(--rpc-border)",
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
            <button type="button" className="rpc-btn-ghost" onClick={clearWallet}>{ownWallet ? "Back to my wallet" : "Clear"}</button>
          </div>
        )}
        {walletError && <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-red)", marginTop: 6 }}>{walletError}</div>}
        {indexing && (
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 8 }}>
            Indexing your collection — check back shortly. This can take a minute on first paste.
          </div>
        )}
        {isSolana && hasWallet && progress && !progress.wallet_cached && (
          <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginTop: 8 }}>
            RPC has no cards indexed for this wallet yet. Holdings refresh on a schedule, not on paste — if this wallet holds cards, the owned count above is not yet known.
          </div>
        )}
      </div>
      )}

      {/* ── Tiles ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Loading checklist…</div>
      ) : failed ? (
        <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>Couldn&apos;t load the checklist right now. This is a temporary load failure, not an empty scope — reload shortly.</div>
      ) : (completeMode ? allFull.length === 0 : rows.length === 0) ? (
        <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>No {unit} for this scope.</div>
      ) : (
        <>
          {/* Three-state legend (mirrors Top Shot's owned/locked/missing) —
              each entry toggles that state's tiles on/off. */}
          {hasWallet && (
            <div role="group" aria-label="Show tiles" style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 10 }}>
              {relevantStates.map(st => (
                <LegendToggle key={st} kind={st} label={OWN_LABEL[st]} on={shownStates.includes(st)} onClick={() => toggleOwnState(st)} />
              ))}
            </div>
          )}
          {shownRows.length === 0 ? (
            <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
              Nothing matches these filters — {ownFilterOn ? "turn a state above back on" : "add a tier back"} to see more.
            </div>
          ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
            {shownRows.map((e, idx) => (
              <ChecklistCard key={`${e.route_slug}-${idx}`} collectionUrlSlug={collectionUrlSlug} e={e} hasWallet={hasWallet} eager={idx < 12} />
            ))}
          </div>
          )}
          {!shownExhausted && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
              {pageFailed && (
                <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-red)" }}>
                  Couldn&apos;t load more — this list is incomplete. Try again.
                </div>
              )}
              <button type="button" className="rpc-btn-ghost" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "Loading…" : pageFailed ? "Retry" : `Load ${PAGE_SIZE} more`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Ownership tri-state palette (shared by tile badge + legend) ───────────────
// green = owned + locked, white = owned (unlocked), gray = missing. Mirrors Top
// Shot's checklist legend.
type OwnState = ChecklistOwnState
const OWN_STYLE: Record<OwnState, { bg: string; border: string; dot: string; text: string }> = {
  locked:  { bg: "rgba(52,211,153,0.16)", border: "1px solid rgba(52,211,153,0.45)", dot: "#34D399", text: "#34D399" },
  owned:   { bg: "var(--rpc-surface-hover)", border: "1px solid var(--rpc-border-hover)", dot: "var(--rpc-text-primary)", text: "var(--rpc-text-primary)" },
  missing: { bg: "var(--rpc-surface-raised)", border: "1px solid var(--rpc-border-hover)", dot: "var(--rpc-text-muted)", text: "var(--rpc-text-primary)" },
}

const OWN_LABEL: Record<OwnState, string> = { locked: "Owned + locked", owned: "Owned", missing: "Missing" }

function LegendToggle({ kind, label, on, onClick }: { kind: OwnState; label: string; on: boolean; onClick: () => void }) {
  const s = OWN_STYLE[kind]
  return (
    <button
      type="button"
      aria-pressed={on}
      title={on ? `Hide ${label.toLowerCase()} tiles` : `Show ${label.toLowerCase()} tiles`}
      onClick={onClick}
      className="rpc-mono"
      style={{
        display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10, color: "var(--rpc-text-secondary)",
        background: "none", border: "none", padding: 0, cursor: "pointer",
        opacity: on ? 1 : 0.45, textDecoration: on ? undefined : "line-through",
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 999, background: on ? s.bg : "transparent", border: s.border, display: "inline-block" }} />
      {label}
    </button>
  )
}

function tierLabel(tier: string | null | undefined): string {
  return tier ? tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase() : "Unknown"
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
  const locked = owned && e.owned_locked === true && collectionHasLocking(collectionUrlSlug)
  const ownState: OwnState = locked ? "locked" : owned ? "owned" : "missing"
  const badgeStyle = OWN_STYLE[ownState]
  // The full-edition view carries the price the header summed; the all-moments
  // tile quotes its own floor/FMV the same way.
  const addCost = e.edition_cost_usd !== undefined ? e.edition_cost_usd : (e.floor_usd ?? e.fmv_usd ?? null)
  // Missing tiles are dimmed slightly so owned pops against them.
  const dim = hasWallet && !owned

  return (
    <Link
      href={editionRouteHref(collectionUrlSlug, e.route_slug)}
      className="rpc-card"
      style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block", opacity: dim ? 0.82 : 1, position: "relative" }}
    >
      <div style={{ position: "relative", aspectRatio: "1 / 1", minHeight: 150, background: "rgba(0,0,0,0.35)", borderRadius: 4, overflow: "hidden", marginBottom: 8 }}>
        {e.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={proxyIpfsUrl(e.thumbnail_url) ?? undefined}
            alt={tileSubject(e)}
            width={200}
            height={200}
            loading={eager ? "eager" : "lazy"}
            decoding={eager ? "sync" : "async"}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", filter: dim ? "grayscale(0.35)" : undefined }}
          />
        ) : (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>No image</div>
        )}
        {/* ownership badge — tri-state (green=owned+locked, white=owned, gray=missing) */}
        {hasWallet && (
          <div
            title={
              (locked ? "Owned + locked" : owned ? "Owned" : "Missing") +
              (owned && typeof e.owned_parallels === "number" && e.owned_parallels > 0 ? " (includes a parallel)" : "")
            }
            style={{
              position: "absolute", top: 6, right: 6, padding: "3px 7px", borderRadius: 999,
              fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: "0.04em",
              background: badgeStyle.bg, border: badgeStyle.border, color: badgeStyle.text,
            }}
          >
            {owned
              ? `✓${e.owned_count && e.owned_count > 1 ? ` ×${e.owned_count}` : ""}${locked ? " 🔒" : ""}`
              : (addCost ? `+ ${fmtUsd(addCost)}` : "+ add")}
          </div>
        )}
      </div>
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
        {tileSubject(e)}
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
        {/* ConfidencePill removed 2026-07-11 — confidence is build-time signal. */}
      </div>
      <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end" }}>
        <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
          Mint {e.circulation_count != null ? fmtCount(e.circulation_count) : EM_DASH}
        </span>
      </div>
    </Link>
  )
}
