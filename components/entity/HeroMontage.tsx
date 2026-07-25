"use client"

// components/entity/HeroMontage.tsx
// Phase 2 (entity media). A small fixed-size row of moment thumbnails shown
// beside the text hero on Set / Team / Series pages, which otherwise have a
// text-only hero. The calling page passes its top editions (24 candidates on
// the team hub); the component renders the first `max` whose thumbnail actually
// loads. Dead-but-non-null URLs (e.g. TS legacy assets.nbatopshot.com/editions/…
// that 404) are pruned on error and the next candidate slides in, so the strip
// never renders blank tiles. Client component only so image errors can be
// caught; its markup still SSRs (decorative / aria-hidden, so no SEO cost).
//
// IMAGE-WEIGHT FIX (2026-07-25). This strip was painting FULL-RESOLUTION IPFS
// masters into its 72px tiles. Since Top Shot pinned all media to IPFS,
// `editions.thumbnail_url` is an `ipfs.dapperlabs.com/ipfs/<cid>` URL for 10,289
// of the 12,920 TS editions that have art (and `ipfs.io/ipfs/<cid>` for all 518
// UFC ones) — and those CIDs are the 2880×2880 archival masters, measured live at
// 3.87–4.66 MB each. Five of them at `fetchPriority="high"` meant ~20 MB of
// blocking image bytes on every Set / Team / Series page, which is why montage
// tiles rendered blank or as broken-image alt text for several seconds.
//
// The IPFS gateways cannot resize (`?width=` is ignored; `/cdn-cgi/image/` 403s),
// but Top Shot's own CDN can: `assets.nbatopshot.com/media/<nft_id>/image?width=N`
// serves a real per-moment derivative — 2,716 bytes at width=144 vs ~4,000,000
// for the master, a ~1,460× reduction, with the resize done upstream so it adds
// no Vercel image-optimization cost. The entity RPCs already return a
// representative `rep_nft_id` per edition (it is exactly what
// `buildEditionImageCandidates` uses for the grid tiles on these same pages, off
// the same array), so prefer that form here and keep the IPFS proxy as the
// error fallback only.

import { useState } from "react"
import { proxyIpfsUrl } from "@/lib/ipfs-media"
import { tsSizedMomentImage } from "@/lib/entity-editions-grid-format"

interface MontageItem {
  thumbnail_url: string | null
  name?: string | null
  // Representative on-chain moment id for the edition. Present on the entity
  // edition RPC rows (non-Pinnacle branch); absent elsewhere, in which case we
  // fall straight through to the IPFS/CDN thumbnail_url.
  rep_nft_id?: string | null
}

// Rendered tile box is 72px; request 2× so it stays crisp on retina without
// paying for the master. 144px lands at ~2.7 KB.
const TILE_PX = 72
const REQUEST_PX = TILE_PX * 2

export default function HeroMontage({
  items,
  max = 5,
  collectionUrlSlug,
}: {
  items: MontageItem[]
  max?: number
  /** Enables the Top Shot sized-derivative source. Omit for other collections. */
  collectionUrlSlug?: string
}) {
  const candidates = (items ?? []).filter((i) => !!i.thumbnail_url)
  const [dead, setDead] = useState<Set<number>>(new Set())
  // Per-tile fallback: a sized CDN derivative that 404s (a moment whose media
  // never made it to the per-moment endpoint) drops back to the IPFS proxy
  // rather than pruning the tile, so we never lose art we actually have.
  const [fellBack, setFellBack] = useState<Set<number>>(new Set())
  if (candidates.length === 0) return null

  const indexed = candidates.map((it, i) => ({ it, i }))
  const shown = indexed.filter(({ i }) => !dead.has(i)).slice(0, max)
  if (shown.length === 0) return null

  return (
    <div
      aria-hidden="true"
      style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflow: "hidden" }}
    >
      {shown.map(({ it, i }) => {
        const proxied = proxyIpfsUrl(it.thumbnail_url)
        const sized = fellBack.has(i)
          ? null
          : tsSizedMomentImage(collectionUrlSlug, it.rep_nft_id, REQUEST_PX)
        const src = sized ?? proxied ?? undefined
        const demote = () => {
          // Prefer demoting to the IPFS original before giving up on the tile.
          if (sized && proxied) setFellBack((s) => new Set(s).add(i))
          else setDead((s) => new Set(s).add(i))
        }
        return (
          <div
            key={i}
            style={{
              width: TILE_PX,
              height: TILE_PX,
              flex: "0 0 auto",
              borderRadius: 4,
              overflow: "hidden",
              border: "1px solid var(--rpc-border)",
              background: "rgba(0,0,0,0.35)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={it.name ?? ""}
              width={TILE_PX}
              height={TILE_PX}
              loading="eager"
              decoding="async"
              onError={demote}
              onLoad={(e) => { if (e.currentTarget.naturalWidth === 0) demote() }}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </div>
        )
      })}
    </div>
  )
}
