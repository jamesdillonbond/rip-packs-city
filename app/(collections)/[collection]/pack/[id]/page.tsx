// app/(collections)/[collection]/pack/[id]/page.tsx
//
// Public-facing pack lifecycle page. Server-rendered from the
// get_pack_lifecycle(p_pack_nft_id text) Postgres RPC, which returns a
// single jsonb object (see ./types.ts for the shape).
//
// Route: /[collection]/pack/[id]
//   - collection: hyphen-form url slug (nba-top-shot, nfl-all-day, …);
//                 the underscore-form (nba_top_shot, ufc-strike, …) is
//                 also accepted on input because lib/collection-slug.ts
//                 maps both.
//   - id:         on-chain pack NFT id as a base-10 string (Flow UInt64).
//
// The page is forced dynamic — pack data updates in real time as the
// pack-events ingest indexer, the wallet_moments_cache hydrator, and FMV
// snapshotter all backfill. Cache pinning would just serve stale lifecycle
// stats.
//
// 308 redirect for distribution slugs:
//   If get_pack_lifecycle returns status='unknown' the id may instead be a
//   distribution slug for the template page at /[collection]/pack/dist/[distId]
//   (the previous URL home of that route, before May 2026). We probe
//   pack_distributions for a match and 308-redirect if found, so old inbound
//   links keep working.
//
// TODO(og-image): build /api/og/pack/lifecycle?id=… that renders a share
// card from the same lifecycle payload (gross pull value, top pulls).
// Currently the metadata uses the generic site OG image.

import type { Metadata } from "next"
import Link from "next/link"
import { redirect } from "next/navigation"
import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import {
  HeroDelta,
  OwnershipTimeline,
  PullsGrid,
  RipPerforation,
  StatsFooter,
} from "./PackLifecycleClient"
import type { PackLifecycle, PackPull } from "./types"

export const dynamic = "force-dynamic"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

interface PageProps {
  params: Promise<{ collection: string; id: string }>
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function fmtUsd(n: number | null): string {
  if (n === null) return "—"
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 })
}

function fmtPrice(n: number | null, currency: string | null | undefined): string {
  if (n === null) return "—"
  const formatted = n.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return currency ? `${formatted} ${currency}` : formatted
}

async function fetchLifecycle(packNftId: string): Promise<PackLifecycle | null> {
  const { data, error } = await sb.rpc("get_pack_lifecycle", { p_pack_nft_id: packNftId })
  if (error) {
    console.log(`[pack-lifecycle] rpc error for ${packNftId}: ${error.message}`)
    return null
  }
  if (!data || typeof data !== "object") return null
  return data as PackLifecycle
}

/** Probe pack_distributions for a known dist_id match — backs the 308 fallback. */
async function isKnownDistId(collectionUuid: string, candidate: string): Promise<boolean> {
  const { data, error } = await sb
    .from("pack_distributions")
    .select("dist_id")
    .eq("collection_id", collectionUuid)
    .eq("dist_id", candidate)
    .limit(1)
    .maybeSingle()
  if (error) return false
  return Boolean(data)
}

// ─────────────────────────────────────────────────────────────────────────
// generateMetadata
// ─────────────────────────────────────────────────────────────────────────

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { collection: routeSlug, id } = await props.params
  const coll = getCollectionByUrlSlug(routeSlug)
  const collectionName = coll?.displayName ?? "Rip Packs City"
  const lifecycle = coll ? await fetchLifecycle(id) : null

  const packLabel = lifecycle?.pack_name ?? `Pack #${id}`
  const metaTitle = `Pack #${id} — ${packLabel} | Rip Packs City`

  let description = `Lifecycle of ${collectionName} pack #${id} on Rip Packs City.`
  if (lifecycle && lifecycle.status === "ripped") {
    const gross = num(lifecycle.stats.gross_pull_value_usd)
    const basis = num(lifecycle.stats.total_cost_basis_usd)
    if (gross !== null && basis !== null) {
      description = `Pulled ${fmtUsd(gross)} from a ${fmtUsd(basis)} pack. See the full rip on Rip Packs City.`
    } else if (gross !== null) {
      description = `Pulled ${fmtUsd(gross)}. See the full rip on Rip Packs City.`
    }
  } else if (lifecycle && lifecycle.status === "sealed") {
    const basis = num(lifecycle.stats.last_cost_basis_usd)
    if (basis !== null) {
      description = `Sealed ${packLabel} last sold for ${fmtUsd(basis)}. Track the rip on Rip Packs City.`
    }
  }

  const canonical = `${BASE_URL}/${routeSlug}/pack/${encodeURIComponent(id)}`
  return {
    title: metaTitle,
    description,
    alternates: { canonical },
    openGraph: {
      title: metaTitle,
      description,
      url: canonical,
      type: "article",
    },
    twitter: {
      card: "summary_large_image",
      title: metaTitle,
      description,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────

export default async function PackLifecyclePage(props: PageProps) {
  const { collection: routeSlug, id } = await props.params
  const coll = getCollectionByUrlSlug(routeSlug)

  // Unknown collection slug → render the not-found surface (still in the
  // collection layout shell so the header/nav stay coherent).
  if (!coll) {
    return <NotFoundCard collectionSlug={routeSlug} id={id} reason="unknown_collection" />
  }

  const lifecycle = await fetchLifecycle(id)

  // Distribution-slug 308: if the lifecycle RPC has no record but the id
  // matches a known pack_distributions row, send the user to the template
  // page at /pack/dist/[distId].
  if (!lifecycle || lifecycle.status === "unknown" || lifecycle.error) {
    const isDist = await isKnownDistId(coll.id, id)
    if (isDist) {
      redirect(`/${routeSlug}/pack/dist/${encodeURIComponent(id)}`)
    }
    return <NotFoundCard collectionSlug={routeSlug} id={id} collectionName={coll.displayName} />
  }

  return <PackLifecycleView lifecycle={lifecycle} routeSlug={routeSlug} collectionName={coll.displayName} />
}

// ─────────────────────────────────────────────────────────────────────────
// PackLifecycleView — main rendered surface
// ─────────────────────────────────────────────────────────────────────────

function PackLifecycleView({
  lifecycle,
  routeSlug,
  collectionName,
}: {
  lifecycle: PackLifecycle
  routeSlug: string
  collectionName: string
}) {
  const packLabel = lifecycle.pack_name ?? `Pack #${lifecycle.pack_nft_id}`

  const grossUsd = num(lifecycle.stats.gross_pull_value_usd)
  const totalBasisUsd = num(lifecycle.stats.total_cost_basis_usd)
  const lastBasisUsd = num(lifecycle.stats.last_cost_basis_usd)
  const lastBasisCurrency = lifecycle.stats.last_cost_basis_currency

  // Headline + delta — different for sealed vs ripped.
  let headline: string
  let delta: string | null = null
  let deltaDir: "up" | "down" | "flat" | null = null
  if (lifecycle.status === "ripped") {
    headline = `Pack ripped for ${fmtUsd(grossUsd)}`
    if (grossUsd !== null && totalBasisUsd !== null) {
      const d = grossUsd - totalBasisUsd
      delta = `${d >= 0 ? "+" : "−"}${fmtUsd(Math.abs(d))} vs cost`
      deltaDir = d > 0 ? "up" : d < 0 ? "down" : "flat"
    }
  } else if (lifecycle.ownership_chain.length > 0) {
    headline = `Last bought for ${fmtPrice(lastBasisUsd, lastBasisCurrency)}`
  } else {
    headline = "First seen sealed"
  }

  const roiPct = (() => {
    const r = num(lifecycle.stats.roi_pct)
    if (r === null) return null
    // RPC may emit ROI as a 0–1 fraction or as a percentage — detect.
    return Math.abs(r) <= 1 ? r * 100 : r
  })()

  return (
    <article>
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        style={{
          fontFamily: "var(--font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.12em",
          fontSize: 11,
          color: "var(--rpc-text-muted)",
          marginBottom: "var(--space-md)",
        }}
      >
        <Link href="/" style={{ color: "inherit", textDecoration: "none" }}>
          Rip Packs City
        </Link>
        <span aria-hidden style={{ margin: "0 8px", color: "var(--rpc-text-ghost)" }}>›</span>
        <Link
          href={`/${routeSlug}/packs`}
          style={{ color: "inherit", textDecoration: "none" }}
        >
          {collectionName}
        </Link>
        <span aria-hidden style={{ margin: "0 8px", color: "var(--rpc-text-ghost)" }}>›</span>
        <span style={{ color: "var(--rpc-text-secondary)" }}>
          Pack #{lifecycle.pack_nft_id}
        </span>
      </nav>

      {/* Hero strip */}
      <header
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto",
          alignItems: "end",
          gap: "var(--space-lg)",
          padding: "var(--space-xl) 0",
          borderBottom: "1px solid var(--rpc-border)",
          marginBottom: "var(--space-2xl)",
        }}
      >
        <div>
          <div
            style={{
              display: "flex",
              gap: "var(--space-md)",
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: "var(--space-sm)",
            }}
          >
            <h1
              style={{
                margin: 0,
                fontFamily: "var(--font-display)",
                fontSize: 40,
                color: "var(--rpc-text-primary)",
                textTransform: "uppercase",
                letterSpacing: "0.02em",
                lineHeight: 1,
              }}
            >
              {packLabel}
            </h1>
            <StatusBadge status={lifecycle.status} />
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              color: "var(--rpc-text-muted)",
            }}
          >
            <span>#{lifecycle.pack_nft_id}</span>
            {lifecycle.first_seen_at && (
              <span title={lifecycle.first_seen_at}>
                <span aria-hidden style={{ margin: "0 8px", color: "var(--rpc-text-ghost)" }}>·</span>
                first seen {relativeFromIso(lifecycle.first_seen_at)}
              </span>
            )}
          </div>
        </div>
        <HeroDelta headline={headline} delta={delta} deltaDirection={deltaDir} />
      </header>

      {/* Ownership chain */}
      <section style={{ marginBottom: "var(--space-2xl)" }}>
        <SectionHeading>Ownership chain</SectionHeading>
        <OwnershipTimeline events={lifecycle.ownership_chain} />
      </section>

      {/* Rip perforation + pulls — only when ripped */}
      {lifecycle.status === "ripped" && lifecycle.rip && (
        <>
          <RipPerforation rip={lifecycle.rip} />
          <section style={{ marginBottom: "var(--space-2xl)" }}>
            <SectionHeading>Pulls</SectionHeading>
            <PullsGrid pulls={lifecycle.pulls as PackPull[]} collection={routeSlug} />
          </section>
        </>
      )}

      {/* Stats footer */}
      <StatsFooter
        totalCostBasisUsd={totalBasisUsd}
        grossPullValueUsd={grossUsd}
        roiPct={roiPct}
      />
    </article>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2
      style={{
        margin: "0 0 var(--space-md) 0",
        fontFamily: "var(--font-display)",
        fontSize: 14,
        color: "var(--rpc-text-secondary)",
        textTransform: "uppercase",
        letterSpacing: "0.14em",
      }}
    >
      {children}
    </h2>
  )
}

function StatusBadge({ status }: { status: PackLifecycle["status"] }) {
  if (status === "ripped") {
    return (
      <span
        style={{
          fontFamily: "var(--font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          fontSize: 12,
          padding: "4px 10px",
          background: "var(--rpc-red)",
          color: "#fff",
          borderRadius: "var(--radius-sm)",
        }}
      >
        Ripped
      </span>
    )
  }
  if (status === "sealed") {
    return (
      <span
        style={{
          fontFamily: "var(--font-display)",
          textTransform: "uppercase",
          letterSpacing: "0.14em",
          fontSize: 12,
          padding: "4px 10px",
          background: "transparent",
          color: "var(--rpc-text-primary)",
          border: "1px solid var(--rpc-text-primary)",
          borderRadius: "var(--radius-sm)",
        }}
      >
        Sealed
      </span>
    )
  }
  return (
    <span
      style={{
        fontFamily: "var(--font-display)",
        textTransform: "uppercase",
        letterSpacing: "0.14em",
        fontSize: 12,
        padding: "4px 10px",
        background: "transparent",
        color: "var(--rpc-text-muted)",
        border: "1px dashed var(--rpc-border)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      Unknown
    </span>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// NotFoundCard
// ─────────────────────────────────────────────────────────────────────────

function NotFoundCard({
  collectionSlug,
  id,
  collectionName,
  reason,
}: {
  collectionSlug: string
  id: string
  collectionName?: string
  reason?: "unknown_collection"
}) {
  const backHref = `/${collectionSlug}/packs`
  return (
    <article
      style={{
        maxWidth: 640,
        margin: "var(--space-2xl) auto",
        padding: "var(--space-2xl)",
        background: "var(--rpc-surface-raised)",
        border: "1px solid var(--rpc-border)",
        borderRadius: "var(--radius-md)",
        textAlign: "center",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: "var(--font-display)",
          fontSize: 28,
          color: "var(--rpc-text-primary)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        Pack not found
      </h1>
      <p
        style={{
          marginTop: "var(--space-md)",
          fontFamily: "var(--font-display)",
          fontSize: 14,
          color: "var(--rpc-text-secondary)",
        }}
      >
        {reason === "unknown_collection"
          ? `We don’t have a collection named "${collectionSlug}".`
          : `We have no record of pack #${id} yet${collectionName ? ` on ${collectionName}` : ""}.`}
      </p>
      <p
        style={{
          marginTop: "var(--space-sm)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--rpc-text-muted)",
        }}
      >
        Pack data backfills in real time — refresh in a few minutes if you just
        opened this pack.
      </p>
      <div style={{ marginTop: "var(--space-xl)" }}>
        <Link
          href={backHref}
          style={{
            display: "inline-block",
            padding: "10px 18px",
            border: "1px solid var(--rpc-red-border)",
            background: "var(--rpc-red-bg)",
            color: "var(--rpc-red)",
            fontFamily: "var(--font-display)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontSize: 12,
            borderRadius: "var(--radius-sm)",
            textDecoration: "none",
          }}
        >
          Back to packs
        </Link>
      </div>
    </article>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Local relative-time formatter (mirrors client-side helper for SSR text)
// ─────────────────────────────────────────────────────────────────────────

function relativeFromIso(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diffSec = Math.max(0, (Date.now() - t) / 1000)
  if (diffSec < 60) return `${Math.floor(diffSec)}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 30 * 86_400) return `${Math.floor(diffSec / 86_400)}d ago`
  if (diffSec < 365 * 86_400) return `${Math.floor(diffSec / (30 * 86_400))}mo ago`
  return `${Math.floor(diffSec / (365 * 86_400))}y ago`
}

