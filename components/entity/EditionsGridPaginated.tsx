"use client"

// components/entity/EditionsGridPaginated.tsx
// Phase 1C/1D/1F. Reusable paginated edition tile grid used by Set, Player,
// and Series pages. Each tile links to /[collection]/edition/[route_slug].
// "Load more" calls the supplied endpoint with offset.

import { useEffect, useState } from "react"
import Link from "next/link"
import { EM_DASH, TierBadge, fmtCount, fmtUsd, tileSubject } from "./_shared"
import { sectionEmptyCopy } from "@/lib/entity/section-empty-copy"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import {
  type EditionSortKey,
  compareEditions,
  isTileVideoEnabled,
  partitionPackRows,
  exhaustedCount as computeExhaustedCount,
  buildLoadMoreUrl,
  buildEditionImageCandidates,
} from "@/lib/entity-editions-grid-format"

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
}

export default function EditionsGridPaginated({ collectionUrlSlug, fetchUrl, initial, initialFailed = false, pageSize, showSetLink = true, showSort = false, packMode = false, exhaustedTotal = 0 }: Props) {
  const [rows, setRows] = useState<EditionTile[]>(initial)
  const [offset, setOffset] = useState<number>(initial.length)
  const [loading, setLoading] = useState(false)
  // ⚠ A FAILED PAGE FETCH IS NOT THE END OF THE LIST — see loadMore().
  const [loadFailed, setLoadFailed] = useState(false)
  const [exhausted, setExhausted] = useState(initial.length < pageSize)
  const [sortKey, setSortKey] = useState<EditionSortKey>("fmv_desc")
  const [showExhausted, setShowExhausted] = useState(false)

  const sorted = showSort ? [...rows].sort((a, b) => compareEditions(a, b, sortKey, tileSubject)) : rows

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
      {showSort && (
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
        {gridRows.map((e, idx) => (
          <EditionTileCard key={e.route_slug} e={e} idx={idx} collectionUrlSlug={collectionUrlSlug} showSetLink={showSetLink} videoEnabled={videoEnabled} />
        ))}
      </div>
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
                  <EditionTileCard key={e.route_slug} e={e} idx={idx} collectionUrlSlug={collectionUrlSlug} showSetLink={showSetLink} videoEnabled={videoEnabled} />
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
}: {
  e: EditionTile
  idx: number
  collectionUrlSlug: string
  showSetLink: boolean
  videoEnabled: boolean
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
        {e.series_label && <span className="rpc-mono" style={{ fontSize: 10, color: "var(--rpc-text-muted)" }}>{e.series_label}</span>}
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
      <div style={{ marginTop: 6, display: "flex", justifyContent: "flex-end", alignItems: "center" }}>
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
