"use client"

// components/entity/EditionsGridPaginated.tsx
// Phase 1C/1D/1F. Reusable paginated edition tile grid used by Set, Player,
// and Series pages. Each tile links to /[collection]/edition/[route_slug].
// "Load more" calls the supplied endpoint with offset.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import Link from "next/link"
import { EM_DASH, TierBadge, fmtCount, fmtUsd, tileSubject } from "./_shared"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"
import { tileSeriesLabel } from "@/lib/series-label"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import {
  type EditionSortKey,
  compareEditions,
  isTileVideoEnabled,
  partitionPackRows,
  exhaustedCount as computeExhaustedCount,
  buildLoadMoreUrl,
  buildEditionImageCandidates,
  tileParallelLabel,
  type EditionFilters,
  type EditionOwnFilter,
  type EditionOwnership,
  EMPTY_EDITION_FILTERS,
  editionFilterOptions,
  filterEditions,
  isEditionFilterActive,
} from "@/lib/entity-editions-grid-format"
import { getCollection } from "@/lib/collections"
import { getOwnerKeyForChain, onOwnerKeyChangeForChain, ownerKeyMatchesChain } from "@/lib/owner-key"

export interface EditionTile {
  route_slug: string
  player_name: string | null
  player_slug?: string | null
  name: string | null
  set_name?: string | null
  set_slug?: string | null
  tier: string | null
  tier_rank?: number | null
  series_label: string | null
  series_num?: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  // Phase 2 (hover-video): moment clip. Returned by the entity edition RPCs
  // for the editions table (Top Shot has video; All Day video_url is null
  // today, so hover-video is effectively TS-only). undefined for Pinnacle.
  video_url?: string | null
  // Team-moment display (TEAM-MOMENT-DISPLAY). TS moments with player_name = null
  // are team moments (WNBA Skyline, Season Rewind, Squad Goals, ...); their subject
  // is the team + play type, mirroring the moment/edition pages' momentSubject and
  // dapper.market ("Chicago Bulls Reel"). team_name + play_type are returned by the
  // entity edition RPCs for the non-Pinnacle branch.
  team_name?: string | null
  play_type?: string | null
  // 2026-09-25: the PARALLEL name ("Hexwave", "Galactic") for a Top Shot
  // subedition — returned by the five entity edition RPCs (migration
  // 20260925173217); NULL for a Standard edition, undefined elsewhere. Without
  // it a player's seven printings of one play rendered as seven identical tiles.
  subedition_name?: string | null
  // Image recovery (2026-06-22 audit, Item 1): a representative on-chain nft_id
  // for the edition. Legacy TS thumbnail_url (assets.nbatopshot.com/editions/…)
  // 404s for ~9k Series 1-4 editions; the per-moment media/<nft_id>/image form
  // works for any serial, so tiles prefer it for Top Shot. Returned by the
  // entity edition RPCs (non-Pinnacle branch); undefined elsewhere.
  rep_nft_id?: string | null
  fmv_usd: number | null
  floor_usd?: number | null
  fmv_confidence?: string | null
  fmv_computed_at?: string | null
  // Pack-content extensions (Phase 2A). Only set by get_pack_contents — every
  // other RPC leaves these undefined and the footer renders the standard
  // confidence + circulation row.
  drop_weight?: number | null
  hit_probability?: number | null
}

// tileSubject (player → team+play → name) lives in ./_shared so server
// components can call it too. Imported above; used by compareEditions + EditionTileCard.

interface Props {
  collectionUrlSlug: string
  /** Endpoint to call for offset-based pagination. Endpoint must echo back an array of EditionTile. */
  fetchUrl: string
  initial: EditionTile[]
  /**
   * Whether the SERVER read that produced `initial` failed.
   *
   * ⚠ Without it an empty `initial` is ambiguous, and this component's empty
   * state CONCLUDES ("No editions yet."). Reachable today from the TEAM page,
   * whose top-editions read is DECORATIVE — `sectionRows` degrades it to `[]`
   * after retries, so a timeout rendered "No editions yet." for a franchise
   * with plenty. The entity pages that pass a STRUCTURAL read already gate this
   * component behind their own `ok`, so for them it stays `false`.
   */
  initialFailed?: boolean
  pageSize: number
  showSetLink?: boolean
  showSort?: boolean
  /**
   * Pack-distribution mode: split loaded rows into pullable (drop_weight > 0
   * or absent) and exhausted (drop_weight === 0). Pullable render in the main
   * grid; exhausted move to a collapsed "pulled out" section. Off for every
   * other importer (player/set/series/team pages) so their tiles are untouched.
   */
  packMode?: boolean
  /** Total exhausted (drop_weight = 0) pool rows, for the collapsed-section header. */
  exhaustedTotal?: number
  /** Team / Set / Series / Rarity / Parallel / Ownership filters over the loaded rows. */
  showFilters?: boolean
  /**
   * "Owned: X  Locked: Y" under FMV on each tile, for the reader's loaded wallet
   * (the per-chain `rpc_owner_key` every Owned/Locked surface uses). Joined on
   * `route_slug` = `wallet_moments_cache.edition_key`, which holds for every
   * collection EXCEPT Pinnacle (its route_slug is a pinnacle_editions id), so
   * Pinnacle never renders the line — a zero there would be a false claim.
   */
  showOwnership?: boolean
}

// The wallet's counts, in all the states a read can be in. Only `ok` may put
// a number on a tile: a missing wallet, a pending read and a failed read are
// all UNKNOWN, and "Owned: 0" out of any of them is the fabricated-zero class.
type OwnershipState =
  | { status: "off" }
  | { status: "loading" }
  | { status: "failed" }
  // The wallet has NO rows in this collection's cache — either it holds none
  // or it was never indexed; the route cannot tell which, so neither do we.
  | { status: "unindexed" }
  | { status: "ok"; map: Map<string, EditionOwnership> }

function useWalletEditionOwnership(enabled: boolean, collectionUrlSlug: string): OwnershipState {
  const dbChain = getCollection(collectionUrlSlug)?.dbChain
  // localStorage is an external store: read it with useSyncExternalStore ("" on
  // the server and at hydration, so SSR never renders a wallet it cannot know).
  const ownerKey = useSyncExternalStore(
    (cb) => (enabled ? onOwnerKeyChangeForChain(dbChain, () => cb()) : () => {}),
    () => (enabled ? getOwnerKeyForChain(dbChain) : ""),
    () => "",
  )
  // The settled result, tagged with the request it answers. "off" and
  // "loading" are DERIVED below, so the effect only sets state from its async
  // callbacks — a result for a previous wallet can never be shown for this one.
  const [settled, setSettled] = useState<{ reqKey: string; state: OwnershipState } | null>(null)
  const active = enabled && !!ownerKey && ownerKeyMatchesChain(ownerKey, dbChain)
  const url = active
    ? `/api/wallet/edition-counts?wallet=${encodeURIComponent(ownerKey)}&collection=${encodeURIComponent(collectionUrlSlug)}`
    : null
  useEffect(() => {
    if (!url) return
    let cancelled = false
    fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15000) })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as { editions?: Record<string, { owned: number; locked: number }> }
      })
      .then((j) => {
        if (cancelled) return
        const map = new Map<string, EditionOwnership>()
        for (const [k, v] of Object.entries(j.editions ?? {})) {
          map.set(k, { owned: Number(v.owned) || 0, locked: Number(v.locked) || 0 })
        }
        setSettled({ reqKey: url, state: map.size === 0 ? { status: "unindexed" } : { status: "ok", map } })
      })
      .catch(() => { if (!cancelled) setSettled({ reqKey: url, state: { status: "failed" } }) })
    return () => { cancelled = true }
  }, [url])
  if (!url) return { status: "off" }
  if (!settled || settled.reqKey !== url) return { status: "loading" }
  return settled.state
}

export default function EditionsGridPaginated({ collectionUrlSlug, fetchUrl, initial, initialFailed = false, pageSize, showSetLink = true, showSort = false, packMode = false, exhaustedTotal = 0, showFilters = false, showOwnership = false }: Props) {
  const [rows, setRows] = useState<EditionTile[]>(initial)
  const [offset, setOffset] = useState<number>(initial.length)
  const [loading, setLoading] = useState(false)
  // ⚠ A FAILED PAGE FETCH IS NOT THE END OF THE LIST — see loadMore().
  const [loadFailed, setLoadFailed] = useState(false)
  const [exhausted, setExhausted] = useState(initial.length < pageSize)
  const [sortKey, setSortKey] = useState<EditionSortKey>("fmv_desc")
  const [showExhausted, setShowExhausted] = useState(false)

  const [filters, setFilters] = useState<EditionFilters>(EMPTY_EDITION_FILTERS)
  const ownership = useWalletEditionOwnership(showOwnership && collectionUrlSlug !== "disney-pinnacle", collectionUrlSlug)
  const ownershipMap = ownership.status === "ok" ? ownership.map : null
  const filterOptions = useMemo(() => editionFilterOptions(rows, collectionUrlSlug), [rows, collectionUrlSlug])
  const filtersActive = showFilters && isEditionFilterActive(filters)
  const visible = filtersActive ? filterEditions(rows, filters, collectionUrlSlug, ownershipMap) : rows

  const sorted = showSort ? [...visible].sort((a, b) => compareEditions(a, b, sortKey, tileSubject)) : visible

  // packMode: pull drop_weight === 0 rows out of the main grid into a collapsed
  // "pulled out" section. Rows with no drop_weight (every non-pack importer)
  // stay in the grid, so those pages are unaffected.
  const { gridRows, exhaustedRows } = partitionPackRows(sorted, packMode)
  const exhaustedCount = computeExhaustedCount(exhaustedTotal, exhaustedRows.length)

  // Hover-video only for collections that actually carry moment clips. Top Shot,
  // All Day, Golazos, and UFC all have editions.video_url populated as of 2026-06-24
  // (UFC backfilled from on-chain MetadataViews.Medias). Pinnacle has no video CDN.
  const videoEnabled = isTileVideoEnabled(collectionUrlSlug)

  async function loadMore() {
    if (loading || exhausted) return
    setLoading(true)
    try {
      const url = buildLoadMoreUrl(fetchUrl, offset, pageSize)
      const r = await fetch(url, { cache: "no-store" })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const next: EditionTile[] = await r.json()
      const safe = Array.isArray(next) ? next : []
      setRows(prev => [...prev, ...safe])
      setOffset(prev => prev + safe.length)
      if (safe.length < pageSize) setExhausted(true)
    } catch {
      // ⚠ THIS USED TO `setExhausted(true)` — a failed request rendered as "that
      // is the whole list". Same class as the empty state below: the reader
      // cannot tell a network failure from the end of the data, and the grid
      // simply stops with no indication. Exhaustion is a claim; a failure is not.
      setLoadFailed(true)
    } finally {
      setLoading(false)
    }
  }

  if (rows.length === 0) {
    return (
      <div style={{ padding: 12, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 12 }}>
        {/* ⚠ The empty wording is UNCHANGED; only the degraded case is new. */}
        {sectionEmptyCopy(!initialFailed, "Editions", "No editions yet.")}
      </div>
    )
  }

  return (
    <div>
      {showFilters && (
        <EditionFilterBar
          filters={filters}
          setFilters={setFilters}
          options={filterOptions}
          ownershipKnown={ownershipMap !== null}
          collectionUrlSlug={collectionUrlSlug}
        />
      )}
      {showOwnership && ownership.status === "failed" && (
        <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10 }}>
          Couldn&rsquo;t load your owned &amp; locked counts &mdash; tiles show no ownership until it loads.
        </div>
      )}
      {showOwnership && ownership.status === "unindexed" && (
        <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10 }}>
          Owned / Locked appears once your loaded wallet is indexed for this collection &mdash; open it in Collection to index it.
        </div>
      )}
      {filtersActive && (
        <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", marginBottom: 10, display: "flex", flexWrap: "wrap", gap: "4px 12px", alignItems: "center" }}>
          <span data-testid="edition-filter-count">
            {visible.length} of {rows.length} loaded edition{rows.length === 1 ? "" : "s"}
            {!exhausted ? " \u00b7 more not loaded yet" : ""}
          </span>
          <button type="button" onClick={() => setFilters(EMPTY_EDITION_FILTERS)} className="rpc-mono" style={{ background: "transparent", border: "none", padding: 0, cursor: "pointer", color: "var(--rpc-red)", fontSize: 11, letterSpacing: "0.06em" }}>
            Clear filters
          </button>
        </div>
      )}
      {showSort && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
          {([
            { k: "fmv_desc",    l: "FMV ↓" },
            { k: "circ_asc",    l: "Mint ↑" },
            { k: "series_desc", l: "Series ↓" },
            { k: "alpha",       l: "A → Z" },
          ] as Array<{ k: EditionSortKey; l: string }>).map(({ k, l }) => (
            <button
              key={k}
              type="button"
              onClick={() => setSortKey(k)}
              className="rpc-chip"
              style={{
                background: sortKey === k ? "var(--rpc-red-bg)" : undefined,
                borderColor: sortKey === k ? "var(--rpc-red-border)" : undefined,
                color: sortKey === k ? "var(--rpc-red)" : undefined,
                cursor: "pointer",
              }}
            >{l}</button>
          ))}
        </div>
      )}
      {filtersActive && gridRows.length === 0 ? (
        <div className="rpc-mono" style={{ padding: 12, fontSize: 12, color: "var(--rpc-text-muted)" }}>
          {/* ⚠ A match against LOADED rows only — never "this player has none". */}
          Nothing among the loaded editions matches these filters{!exhausted ? " \u2014 load more to search the rest" : ""}.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
          {gridRows.map((e, idx) => (
            <EditionTileCard key={e.route_slug} e={e} idx={idx} collectionUrlSlug={collectionUrlSlug} showSetLink={showSetLink} videoEnabled={videoEnabled} ownership={ownershipMap ? (ownershipMap.get(e.route_slug) ?? { owned: 0, locked: 0 }) : null} />
          ))}
        </div>
      )}
      {!exhausted && (
        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
          {/* ⚠ The failure line, and the button STAYS so the reader can retry.
              Previously a failed fetch set `exhausted`, which removed the button
              and left the list looking complete. */}
          {loadFailed && (
            <div className="rpc-mono" style={{ fontSize: 11, color: "var(--rpc-text-muted)", textAlign: "center" }}>
              Couldn&rsquo;t load more &mdash; that isn&rsquo;t the end of the list. Try again.
            </div>
          )}
          <button
            type="button"
            className="rpc-btn-ghost"
            disabled={loading}
            onClick={() => {
              setLoadFailed(false)
              void loadMore()
            }}
          >
            {loading ? "Loading…" : loadFailed ? "Retry" : `Load ${pageSize} more`}
          </button>
        </div>
      )}

      {packMode && exhaustedCount > 0 && (
        <div style={{ marginTop: 16, borderTop: "1px solid var(--rpc-border-subtle)", paddingTop: 12 }}>
          <button
            type="button"
            onClick={() => setShowExhausted((v) => !v)}
            className="rpc-mono"
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--rpc-text-secondary)",
              fontSize: 11,
              letterSpacing: "0.10em",
              textTransform: "uppercase",
              padding: 0,
            }}
          >
            {showExhausted ? "▾" : "▸"} Exhausted / pulled out ({exhaustedCount})
          </button>
          {showExhausted && (
            exhaustedRows.length === 0 ? (
              <div style={{ marginTop: 10, color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                Load more above to reveal the exhausted editions (they sort after the pullable ones).
              </div>
            ) : (
              <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10, opacity: 0.6 }}>
                {exhaustedRows.map((e, idx) => (
                  <EditionTileCard key={e.route_slug} e={e} idx={idx} collectionUrlSlug={collectionUrlSlug} showSetLink={showSetLink} videoEnabled={videoEnabled} ownership={ownershipMap ? (ownershipMap.get(e.route_slug) ?? { owned: 0, locked: 0 }) : null} />
                ))}
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

// Single edition tile, shared by the main grid and the packMode "exhausted"
// section so both render identically.
function EditionTileCard({
  e,
  idx,
  collectionUrlSlug,
  showSetLink,
  videoEnabled,
  ownership,
}: {
  e: EditionTile
  idx: number
  collectionUrlSlug: string
  showSetLink: boolean
  videoEnabled: boolean
  /** null = counts not KNOWN (no wallet / loading / failed) — render nothing, never a zero. */
  ownership: EditionOwnership | null
}) {
  return (
    <Link
      href={`/${collectionUrlSlug}/edition/${encodeURIComponent(e.route_slug)}`}
      className="rpc-card"
      style={{ padding: 10, textDecoration: "none", color: "inherit", display: "block" }}
    >
      <TileMedia
        imageCandidates={buildEditionImageCandidates(e, collectionUrlSlug)}
        videoUrl={proxyIpfsUrl(e.video_url ?? null)}
        alt={tileSubject(e)}
        eager={idx < 12}
        videoEnabled={videoEnabled}
      />
      <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 14, color: "var(--rpc-text-primary)", letterSpacing: "0.04em", lineHeight: 1.2, marginBottom: 4 }}>
        {tileSubject(e)}
      </div>
      {showSetLink && e.set_name && (
        <div className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)", marginBottom: 6 }}>{e.set_name}</div>
      )}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
        <TierBadge tier={e.tier} />
        {e.series_label && <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{tileSeriesLabel(e.series_label, collectionUrlSlug)}</span>}
        {tileParallelLabel(e, collectionUrlSlug) ? (
          <span
            className="rpc-mono"
            data-testid="tile-parallel"
            title="Parallel printing"
            style={{ fontSize: 10, color: "var(--rpc-text-secondary)", letterSpacing: "0.10em", textTransform: "uppercase", border: "1px solid var(--rpc-border-subtle)", borderRadius: 4, padding: "0 5px" }}
          >
            {tileParallelLabel(e, collectionUrlSlug)}
          </span>
        ) : null}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>FMV</div>
          <div style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: 16, color: "var(--rpc-text-primary)" }}>{fmtUsd(e.fmv_usd)}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div className="rpc-mono" style={{ fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.14em" }}>Floor</div>
          <div className="rpc-mono" style={{ fontSize: 12, color: "var(--rpc-text-secondary)" }}>{fmtUsd(e.floor_usd ?? null)}</div>
        </div>
      </div>
      {/* ConfidencePill removed 2026-07-11 — confidence is build-time signal. */}
      <div style={{ marginTop: 6, display: "flex", justifyContent: ownership ? "space-between" : "flex-end", alignItems: "center", gap: 8 }}>
        {ownership && (
          <span className="rpc-mono" data-testid="tile-ownership" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>
            Owned: <span style={{ color: ownership.owned > 0 ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)", fontWeight: ownership.owned > 0 ? 700 : 400 }}>{fmtCount(ownership.owned)}</span>
            <span style={{ marginLeft: 10 }}>Locked:</span> <span style={{ color: ownership.locked > 0 ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)", fontWeight: ownership.locked > 0 ? 700 : 400 }}>{fmtCount(ownership.locked)}</span>
          </span>
        )}
        {e.circulation_count !== null && e.circulation_count !== undefined && (
          <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>
            Mint {fmtCount(e.circulation_count)}
          </span>
        )}
        {(e.circulation_count === null || e.circulation_count === undefined) && (
          <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>Mint {EM_DASH}</span>
        )}
      </div>
      {(e.hit_probability !== undefined && e.hit_probability !== null) && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid var(--rpc-border-subtle)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)", letterSpacing: "0.10em" }}>
            Hit {(e.hit_probability * 100).toFixed(2)}%
          </span>
          {(e.drop_weight !== undefined && e.drop_weight !== null) && (
            <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-secondary)" }}>
              Wt {fmtCount(e.drop_weight)}
            </span>
          )}
        </div>
      )}
    </Link>
  )
}

function EditionFilterBar({
  filters,
  setFilters,
  options,
  ownershipKnown,
  collectionUrlSlug,
}: {
  filters: EditionFilters
  setFilters: (f: EditionFilters) => void
  options: ReturnType<typeof editionFilterOptions>
  ownershipKnown: boolean
  collectionUrlSlug: string
}) {
  const set = <K extends keyof EditionFilters>(k: K, v: EditionFilters[K]) => setFilters({ ...filters, [k]: v })
  // A select with one option filters nothing — hide it rather than offer a no-op.
  const selects: Array<{ k: "team" | "set" | "series" | "tier" | "parallel"; all: string; opts: string[]; label?: (v: string) => string }> = [
    { k: "team", all: "All Teams", opts: options.teams },
    { k: "set", all: "All Sets", opts: options.sets },
    { k: "series", all: "All Series", opts: options.series, label: (v) => tileSeriesLabel(v, collectionUrlSlug) ?? v },
    { k: "tier", all: "All Rarities", opts: options.tiers },
    { k: "parallel", all: "All Parallels", opts: options.parallels },
  ]
  return (
    <div data-testid="edition-filters" className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4" style={{ marginBottom: 10 }}>
      <input
        value={filters.q}
        onChange={(ev) => set("q", ev.target.value)}
        placeholder="Filter editions…"
        aria-label="Filter editions"
        className="rpc-filter-input col-span-2 sm:col-span-1"
      />
      {selects.filter((s) => s.opts.length > 1 || filters[s.k] !== "all").map((s) => (
        <select key={s.k} aria-label={s.all} value={filters[s.k]} onChange={(ev) => set(s.k, ev.target.value)} className="rpc-filter-select">
          <option value="all">{s.all}</option>
          {s.opts.map((v) => <option key={v} value={v}>{s.label ? s.label(v) : v}</option>)}
        </select>
      ))}
      {/* Only offered once the wallet's counts are KNOWN — otherwise "Owned"
          would filter against nothing and read as "you own none of these". */}
      {ownershipKnown && (
        <select aria-label="Ownership" value={filters.own} onChange={(ev) => set("own", ev.target.value as EditionOwnFilter)} className="rpc-filter-select">
          <option value="all">All Ownership</option>
          <option value="owned">Owned</option>
          <option value="not_owned">Not Owned</option>
          <option value="locked">Locked</option>
        </select>
      )}
    </div>
  )
}

// prefers-reduced-motion guard — SSR-safe (defaults to false until mounted).
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(mq.matches)
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener?.("change", onChange)
    return () => mq.removeEventListener?.("change", onChange)
  }, [])
  return reduced
}

// Tile media: static thumbnail at rest; on hover, mount a muted/looping clip
// over it (poster = thumbnail) like nbatopshot.com. The <video> is mounted
// only on first hover so large grids stay cheap, and never for reduced-motion
// users or collections without video. Preserves the iOS/Chrome aspect-ratio
// minHeight fallback the static <img> relied on.
function TileMedia({
  imageCandidates,
  videoUrl,
  alt,
  eager,
  videoEnabled,
}: {
  imageCandidates: string[]
  videoUrl: string | null
  alt: string
  eager: boolean
  videoEnabled: boolean
}) {
  const reduced = usePrefersReducedMotion()
  const [hover, setHover] = useState(false)
  const [imgIdx, setImgIdx] = useState(0)
  const canVideo = videoEnabled && !!videoUrl && !reduced
  const currentImg = imgIdx < imageCandidates.length ? imageCandidates[imgIdx] : null

  return (
    <div
      onMouseEnter={canVideo ? () => setHover(true) : undefined}
      onMouseLeave={canVideo ? () => setHover(false) : undefined}
      style={{
        position: "relative",
        aspectRatio: "1 / 1",
        minHeight: 160,
        background: "rgba(0,0,0,0.35)",
        borderRadius: 4,
        overflow: "hidden",
        marginBottom: 8,
      }}
    >
      {currentImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={currentImg}
          alt={alt}
          width={220}
          height={220}
          loading={eager ? "eager" : "lazy"}
          decoding={eager ? "sync" : "async"}
          onError={() => setImgIdx((i) => i + 1)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--rpc-text-ghost)", fontFamily: "var(--font-mono)", fontSize: 10 }}>No image</div>
      )}
      {canVideo && hover && (
        <video
          src={videoUrl as string}
          poster={currentImg ?? undefined}
          muted
          loop
          autoPlay
          playsInline
          preload="none"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      )}
    </div>
  )
}
