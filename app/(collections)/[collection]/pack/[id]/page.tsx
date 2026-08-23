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
// OG image: generateMetadata points the share card at
// /api/og/pack/lifecycle?id=… which renders gross pull value, cost basis, and
// the top pulls from this same lifecycle payload.

import type { Metadata } from "next"
import type { ReactNode } from "react"
import Link from "next/link"
import { redirect } from "next/navigation"
import { fetchLifecycle, isKnownDistId } from "@/lib/pack-detail/lifecycle"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { metaField } from "@/lib/format"
import {
  HeroDelta,
  OwnershipTimeline,
  PackIdentityHero,
  PackIdentityMinimal,
  PullsGrid,
  RipPerforation,
  StatsFooter,
} from "./PackLifecycleClient"
import type { PackLifecycle, PackPull } from "./types"
import { OG_INHERITED, TWITTER_INHERITED } from "@/lib/seo"

export const dynamic = "force-dynamic"

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

interface PageProps {
  params: Promise<{ collection: string; id: string }>
}


function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** Whole-dollar amounts drop the trailing ".00" so headlines read "$20"
 *  rather than "$20.00". Mirrors the client-side helper. */
function fmtUsd(n: number | null): string {
  if (n === null) return "—"
  if (n === Math.trunc(n)) return `$${n.toLocaleString("en-US")}`
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function fmtPrice(n: number | null, currency: string | null | undefined): string {
  if (n === null) return "—"
  const formatted = n.toLocaleString("en-US", { maximumFractionDigits: 4 })
  return currency ? `${formatted} ${currency}` : formatted
}

/** DUC is 1:1 USD-pegged, so render DUC amounts as plain USD and drop the
 *  "DUC" suffix entirely. Non-DUC currencies keep their suffix. */
function fmtPriceWithUsd(n: number | null, currency: string | null | undefined): string {
  if (n === null) return "—"
  if (currency && currency.toUpperCase() === "DUC") return fmtUsd(n)
  return fmtPrice(n, currency)
}


// ─────────────────────────────────────────────────────────────────────────
// generateMetadata
// ─────────────────────────────────────────────────────────────────────────

export async function generateMetadata(props: PageProps): Promise<Metadata> {
  const { collection: routeSlug, id } = await props.params
  const coll = getCollectionByUrlSlug(routeSlug)
  const collectionName = coll?.displayName ?? "Rip Packs City"
  // ⚠ `ok` is load-bearing and used to be dropped here. The page body below
  // destructures it (line ~207) precisely because a failed read and an unknown
  // pack are different answers; this function treated both as "no lifecycle" and
  // published the generic fallback description for a real pack whose read merely
  // timed out — indexable, with no indication anything went wrong.
  const lifecycleRes = coll ? await fetchLifecycle(id) : null
  const lifecycle = lifecycleRes?.lifecycle ?? null
  const readOk = lifecycleRes ? lifecycleRes.ok : true
  if (coll && !lifecycle && !readOk) {
    return {
      title: { absolute: `Pack #${id} — Unavailable | Rip Packs City` },
      description: "We couldn't load this pack right now. Try again in a moment.",
      robots: { index: false, follow: true },
    }
  }

  // metaField (2026-07-25): both are raw catalog text, and all four description
  // branches below plus metaTitle interpolate them next to a separator or a "(",
  // so trimming at the read closes every branch at once.
  const distTitle = metaField(lifecycle?.distribution?.title)
  const packLabel = distTitle ?? metaField(lifecycle?.pack_name) ?? `Pack #${id}`
  const metaTitle = distTitle
    ? `${distTitle} — Pack #${id} | Rip Packs City`
    : `Pack #${id} — ${packLabel} | Rip Packs City`

  let description = `Lifecycle of ${collectionName} pack #${id} on Rip Packs City.`
  if (lifecycle && lifecycle.status === "ripped") {
    const gross = num(lifecycle.stats.gross_pull_value_usd)
    const basis = num(lifecycle.stats.total_cost_basis)
    const currency = lifecycle.stats.currency
    const retail = num(lifecycle.distribution?.retail_price_usd ?? null)
    if (gross !== null && distTitle && retail !== null) {
      description = `Pulled ${fmtUsd(gross)} from a ${distTitle} (${fmtUsd(retail)} retail). See the full rip on Rip Packs City.`
    } else if (gross !== null && basis !== null) {
      description = `Pulled ${fmtUsd(gross)} from a ${fmtPriceWithUsd(basis, currency)} pack. See the full rip on Rip Packs City.`
    } else if (gross !== null) {
      description = `Pulled ${fmtUsd(gross)}. See the full rip on Rip Packs City.`
    }
  } else if (lifecycle && lifecycle.status === "sealed") {
    const basis = num(lifecycle.stats.total_cost_basis)
    const currency = lifecycle.stats.currency
    if (basis !== null) {
      description = `Sealed ${packLabel} last sold for ${fmtPriceWithUsd(basis, currency)}. Track the rip on Rip Packs City.`
    }
  }

  const canonical = `${BASE_URL}/${routeSlug}/pack/${encodeURIComponent(id)}`
  // Per-pack share card rendered from the same get_pack_lifecycle payload
  // (gross pull value, cost basis, top pulls). Falls back to a generic PACK
  // card server-side when the pack is unresolved — never 500s — so it's safe
  // to always advertise. See app/api/og/pack/lifecycle/route.tsx.
  const ogImage = `${BASE_URL}/api/og/pack/lifecycle?id=${encodeURIComponent(id)}&collection=${encodeURIComponent(routeSlug)}`
  return {
    // `absolute`: this title already carries the brand, and the collection
    // subtree now re-declares the `%s | Rip Packs City` template (R31).
    title: { absolute: metaTitle },
    description,
    alternates: { canonical },
    openGraph: {
      ...OG_INHERITED,
      title: metaTitle,
      description,
      url: canonical,
      type: "article",
      images: [{ url: ogImage, width: 1200, height: 630, alt: packLabel }],
    },
    twitter: {
      ...TWITTER_INHERITED,
      card: "summary_large_image",
      title: metaTitle,
      description,
      images: [ogImage],
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

  const { lifecycle, ok } = await fetchLifecycle(id)

  // The RPC FAILED — say so. Do NOT fall through to the not-found/redirect
  // branch below: telling a visitor this pack does not exist, or bouncing them
  // to a dist page, on the strength of a statement timeout is a fabricated
  // answer, and the card is served at 200 so crawlers would read it as a
  // soft-404 for a page that is real.
  if (!ok) {
    return (
      <UnavailableCard collectionSlug={routeSlug} id={id} collectionName={coll.displayName} />
    )
  }

  // Distribution-slug 308: if the lifecycle RPC has no record but the id
  // matches a known pack_distributions row, send the user to the template
  // page at /pack/dist/[distId].
  if (!lifecycle || lifecycle.status === "unknown" || lifecycle.error) {
    const { known: isDist, ok: probeOk } = await isKnownDistId(coll.id, id)
    if (isDist) {
      redirect(`/${routeSlug}/pack/dist/${encodeURIComponent(id)}`)
    }
    // ⚠ A FAILED PROBE IS NOT "not a distribution". The probe used to return a
    // bare `false` on error, and this branch reads `false` as "no such dist" and
    // renders the NotFoundCard — so a statement timeout told a visitor a real
    // distribution does not exist, at HTTP 200, which is a soft-404 to crawlers
    // as well. That is the exact conflation `fetchLifecycle` was fixed for, one
    // line above it and left behind. UnavailableCard already exists for this.
    if (!probeOk) {
      return (
        <UnavailableCard collectionSlug={routeSlug} id={id} collectionName={coll.displayName} />
      )
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
  const grossUsd = num(lifecycle.stats.gross_pull_value_usd)
  const totalBasis = num(lifecycle.stats.total_cost_basis)
  const basisCurrency = lifecycle.stats.currency
  const retailUsd = num(lifecycle.distribution?.retail_price_usd ?? null)

  // ROI = ((gross - cost) / cost) * 100. DUC is 1:1 USD so we can compare
  // total_cost_basis directly to gross_pull_value_usd without conversion.
  // For non-DUC, non-USD currencies a price lookup would be needed; today
  // every observed pack purchase is DUC, so this matches reality.
  const roiPct =
    grossUsd !== null && totalBasis !== null && totalBasis !== 0
      ? ((grossUsd - totalBasis) / totalBasis) * 100
      : null

  // Last ownership-chain row backs the "sealed-with-history" headline (the
  // RPC no longer emits a dedicated last_cost_basis field).
  const lastChainRow =
    lifecycle.ownership_chain.length > 0
      ? lifecycle.ownership_chain[lifecycle.ownership_chain.length - 1]
      : null

  // Hero copy — four cases.
  //
  //   ripped:           "PULLED $X" headline (sign-colored) +
  //                     "PAID $Y" subhead (display font + mono amount) +
  //                     "+/-$Z vs cost" delta line (red/green).
  //   sealed + chain:   "Last bought for $Y" (no subhead, no delta).
  //   sealed + retail:  "RETAIL $Y" headline + "NOT YET BOUGHT" subhead.
  //   sealed + nothing: "First seen sealed".
  //
  // The PAID vs RETAIL distinction is deliberate — RETAIL is what the pack
  // cost at drop time and is shown for context in the identity hero; PAID is
  // what *this user* paid on the secondary market and anchors the ROI math.
  let headline: string
  let subhead: ReactNode | null = null
  let delta: string | null = null
  let deltaDir: "up" | "down" | "flat" | null = null
  if (lifecycle.status === "ripped") {
    headline = `PULLED ${fmtUsd(grossUsd)}`
    if (totalBasis !== null) {
      subhead = (
        <>
          PAID{" "}
          <span className="rpc-hero-sub-amt">
            {fmtPriceWithUsd(totalBasis, basisCurrency)}
          </span>
        </>
      )
    }
    if (grossUsd !== null && totalBasis !== null) {
      const d = grossUsd - totalBasis
      delta = `${d >= 0 ? "+" : "−"}${fmtUsd(Math.abs(d))} vs cost`
      deltaDir = d > 0 ? "up" : d < 0 ? "down" : "flat"
    }
  } else if (lastChainRow) {
    headline = `Last bought for ${fmtPriceWithUsd(num(lastChainRow.sale_price), lastChainRow.sale_currency)}`
  } else if (retailUsd !== null) {
    headline = `RETAIL ${fmtUsd(retailUsd)}`
    subhead = "NOT YET BOUGHT"
  } else {
    headline = "First seen sealed"
  }

  return (
    <article style={{ display: "block" }}>
      {/* Page-scoped responsive CSS. React 19 hoists style tags with
          `precedence` into <head> so this works in SSR. The `href` acts as
          a dedup key — duplicate renders share one stylesheet. */}
      <style href="rpc-pack-lifecycle" precedence="default">{`
        .rpc-pack-header {
          display: flex;
          flex-direction: row;
          align-items: flex-start;
          justify-content: space-between;
          gap: var(--space-xl);
          padding: var(--space-xl) 0;
          border-bottom: 1px solid var(--rpc-border);
          margin-bottom: var(--space-2xl);
          flex-wrap: nowrap;
        }
        .rpc-pack-header-id { flex: 1 1 480px; min-width: 0; }
        .rpc-pack-header-delta { flex: 0 1 auto; align-self: flex-end; }

        @media (max-width: 640px) {
          .rpc-pack-header {
            flex-direction: column-reverse;
            gap: var(--space-lg);
            padding: var(--space-lg) 0;
            margin-bottom: var(--space-lg);
          }
          .rpc-pack-header-id,
          .rpc-pack-header-delta {
            flex: 0 0 auto;
            align-self: stretch;
            width: 100%;
          }
        }

        .rpc-pack-id {
          display: flex;
          gap: var(--space-lg);
          align-items: flex-start;
        }
        @media (max-width: 640px) {
          .rpc-pack-id { gap: var(--space-md); }
        }

        .rpc-pack-id-image {
          flex-shrink: 0;
          position: relative;
          width: 200px;
          aspect-ratio: 5 / 7;
          background: var(--rpc-surface-raised);
          border: 1px solid var(--rpc-border);
          border-radius: var(--radius-md);
          box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          overflow: hidden;
        }
        .rpc-pack-id-image > img,
        .rpc-pack-id-image > div {
          position: absolute;
          inset: 0;
          width: 100%;
          height: 100%;
        }
        .rpc-pack-id-image > img { object-fit: cover; }
        @media (max-width: 640px) {
          .rpc-pack-id-image { width: 96px; }
        }

        .rpc-pack-id-text { flex: 1 1 0; min-width: 0; }

        .rpc-pack-id-title-row {
          display: flex;
          gap: var(--space-md);
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: var(--space-sm);
        }
        .rpc-pack-id-title {
          margin: 0;
          font-family: var(--font-display);
          font-size: 36px;
          color: var(--rpc-text-primary);
          text-transform: uppercase;
          letter-spacing: 0.02em;
          line-height: 1.05;
          overflow-wrap: break-word;
          word-break: break-word;
        }
        @media (max-width: 640px) {
          .rpc-pack-id-title { font-size: 22px; line-height: 1.1; }
        }

        .rpc-pack-id-tagrow {
          display: flex;
          gap: var(--space-sm);
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: var(--space-md);
        }
        .rpc-pack-id-meta-row {
          display: flex;
          gap: var(--space-md);
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: var(--space-md);
        }
        .rpc-pack-id-meta-pill {
          font-family: var(--font-display);
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--rpc-text-muted);
        }

        .rpc-hero-delta { text-align: right; }
        @media (max-width: 640px) {
          .rpc-hero-delta { text-align: left; }
        }
        .rpc-hero-pulled {
          font-family: var(--font-display);
          font-size: 44px;
          text-transform: uppercase;
          letter-spacing: 0.02em;
          line-height: 1;
        }
        @media (max-width: 640px) {
          .rpc-hero-pulled { font-size: 32px; }
        }
        .rpc-hero-sub {
          margin-top: 6px;
          font-family: var(--font-display);
          font-size: 14px;
          text-transform: uppercase;
          letter-spacing: 0.1em;
          color: var(--rpc-text-muted);
        }
        .rpc-hero-sub-amt {
          font-family: var(--font-mono);
          color: var(--rpc-text-secondary);
          text-transform: none;
          letter-spacing: 0;
        }
        .rpc-hero-delta-line {
          margin-top: 6px;
          font-family: var(--font-mono);
          font-size: 14px;
        }
      `}</style>

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

      {/* Hero — pack identity on the left, PULLED/PAID/delta block on the
          right (desktop). On mobile the order flips: PULLED/PAID/delta first
          so the headline number is above the fold for screenshot-sharing,
          then identity below. When `distribution` is null we render a
          minimal title-only identity instead of a "?" placeholder card. */}
      <header className="rpc-pack-header">
        <div className="rpc-pack-header-id">
          {lifecycle.distribution ? (
            <PackIdentityHero
              distribution={lifecycle.distribution}
              packNftId={lifecycle.pack_nft_id}
              packName={lifecycle.pack_name}
              status={lifecycle.status}
              firstSeenAt={lifecycle.first_seen_at}
            />
          ) : (
            <PackIdentityMinimal
              packName={lifecycle.pack_name}
              packNftId={lifecycle.pack_nft_id}
              status={lifecycle.status}
              firstSeenAt={lifecycle.first_seen_at}
            />
          )}
        </div>
        <div className="rpc-pack-header-delta">
          <HeroDelta
            headline={headline}
            subhead={subhead}
            delta={delta}
            deltaDirection={deltaDir}
          />
        </div>
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
        totalCostBasis={totalBasis}
        basisCurrency={basisCurrency}
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

// ─────────────────────────────────────────────────────────────────────────
// UnavailableCard — shown when the lifecycle RPC FAILED.
//
// Deliberately NOT the NotFoundCard: "we could not look this up" and "this pack
// does not exist" are different answers, and only one of them is true when the
// database times out. The copy commits to nothing about whether the pack exists.
// ─────────────────────────────────────────────────────────────────────────

function UnavailableCard({
  collectionSlug,
  id,
  collectionName,
}: {
  collectionSlug: string
  id: string
  collectionName?: string
}) {
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
        Pack details unavailable
      </h1>
      <p
        style={{
          margin: "var(--space-md) 0 0",
          fontFamily: "var(--font-mono)",
          fontSize: 14,
          lineHeight: 1.6,
          color: "var(--rpc-text-secondary)",
        }}
      >
        We couldn&rsquo;t load pack <strong>#{id}</strong>
        {collectionName ? ` on ${collectionName}` : ""} just now — the database is under heavy load.
        This does <strong>not</strong> mean the pack doesn&rsquo;t exist. Please try again in a minute.
      </p>
      <p style={{ margin: "var(--space-lg) 0 0" }}>
        <Link
          href={`/${collectionSlug}/packs`}
          style={{ color: "var(--rpc-red)", fontFamily: "var(--font-mono)", fontSize: 13 }}
        >
          ← Back to packs
        </Link>
      </p>
    </article>
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

