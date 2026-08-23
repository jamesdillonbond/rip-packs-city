// Per-set detail page. Renders the set header (collection + series + name +
// tier), aggregate roll-ups (edition count, robust total FMV, median, outlier
// flag), and a grid of edition cards.
//
// Pre-renders the top-100 most valuable sets via generateStaticParams so the
// highest-traffic set pages are fast at build; lower-value sets fall through
// to ISR on first request.

import type { Metadata } from "next"
import { notFound } from "next/navigation"
import Link from "next/link"
import { loadSet } from "@/lib/analytics/sets/detail-fetchers"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"
import { seriesLabel } from "@/lib/analytics/series-labels"
import { COLLECTION_LABEL } from "@/lib/analytics-sets-dashboard-compute"
import { joinMetaParts, metaField } from "@/lib/format"
import EditionGrid from "@/components/analytics/EditionGrid"
import { FreshnessStamp } from "@/components/insights/FreshnessStamp"
import type {
  SetsDetailResponse,
  SetsDirectoryRow,
} from "@/lib/analytics-types"

export const revalidate = 21600
export const dynamicParams = true

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// COLLECTION_LABEL imported from lib/analytics-sets-dashboard-compute (the
// canonical map SetsDashboard also uses) so this page can't drift behind it —
// a local copy here was missing keys and rendered raw slugs (e.g. "candy_mlb").

// brand-exception: tier-badge colors carry rarity meaning; intentional in both themes
const TIER_COLOR: Record<string, string> = {
  Common: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  Fandom: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  Rare: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  Legendary: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  Ultimate: "bg-rose-500/15 text-rose-300 border-rose-500/40",
}

interface PageParams {
  params: Promise<{ set_id: string }>
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export { setDetailStaticParams as generateStaticParams } from "@/lib/analytics/sets/detail-fetchers"

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { set_id } = await params
  if (!UUID_RE.test(set_id)) {
    return { title: "Set not found" }
  }
  const { data, ok } = await loadSet(set_id)
  // Only an ANSWERED read may claim the set does not exist.
  if (!data) {
    return { title: ok ? "Set not found — Rip Packs City" : "Set unavailable — Rip Packs City" }
  }

  const collectionLabel = COLLECTION_LABEL[data.collection?.toLowerCase()] ?? data.collection
  const series = seriesLabel(data.collection, data.series)
  const editionCount = data.editions?.length ?? 0

  // metaField (2026-07-25): set_name is raw catalog text; an untrimmed value used
  // to leak whitespace ahead of the " — " separator and the "(" in the description.
  const setName = metaField(data.set_name) ?? "Set"
  const title = joinMetaParts([setName, joinMetaParts([collectionLabel, series], " · ")], " — ")
  const description = `Catalog rollup for ${setName} (${joinMetaParts([collectionLabel, series], ", ")}). ${editionCount} edition${editionCount === 1 ? "" : "s"} with FMV coverage and per-edition values.`

  return analyticsMetadata({
    title,
    description,
    path: `/analytics/sets/${set_id}`,
  })
}

export default async function SetDetailPage({ params }: PageParams) {
  const { set_id } = await params
  if (!UUID_RE.test(set_id)) notFound()
  const { data, ok } = await loadSet(set_id)
  // A failed/slow read must NOT render as "no such set" — see loadSet.
  if (!ok) return <SetUnavailableCard setId={set_id} />
  if (!data) notFound()

  const editions = data.editions ?? []
  const editionCount = editions.length
  const fmvVals = editions
    .map((e) => e.fmv_usd)
    .filter((v): v is number => v != null && Number.isFinite(v))
  const totalRaw = fmvVals.reduce((s, v) => s + v, 0)
  const median = (() => {
    if (fmvVals.length === 0) return null
    const sorted = [...fmvVals].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  })()
  // Robust total — cap each edition FMV at 20× set median (matches RPC convention).
  const robustCap = median != null && median > 0 ? median * 20 : null
  const robustTotal =
    robustCap != null
      ? fmvVals.reduce((s, v) => s + Math.min(v, robustCap), 0)
      : totalRaw
  const hasOutlier = robustCap != null && fmvVals.some((v) => v > robustCap)

  const collectionLabel =
    COLLECTION_LABEL[data.collection?.toLowerCase()] ?? data.collection
  const series = seriesLabel(data.collection, data.series)
  const tierKey =
    data.tier && data.tier in TIER_COLOR ? (data.tier as keyof typeof TIER_COLOR) : null
  const tierCls = tierKey
    ? TIER_COLOR[tierKey]
    // brand-exception: neutral tier-badge fallback, matches the tier-color scale
    : "bg-zinc-700/40 text-zinc-300 border-zinc-600/40"

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    // Same trim rule as generateMetadata — JSON-LD is machine-read.
    name: joinMetaParts([metaField(data.set_name) ?? "Set", joinMetaParts([collectionLabel, series], " ")], " — "),
    description: `Catalog detail for ${metaField(data.set_name) ?? "this set"} with ${editionCount} editions.`,
    creator: { "@type": "Organization", name: "Rip Packs City" },
    url: `${ANALYTICS_BASE_URL}/analytics/sets/${set_id}`,
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <div className="space-y-8">
        <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] p-6">
          <Link
            href="/analytics/sets"
            className="text-xs text-[color:var(--rpc-text-muted)] hover:text-violet-400 transition-colors inline-block mb-3"
          >
            ← Back to Sets
          </Link>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="rounded border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-violet-300">
              {collectionLabel}
            </span>
            <span className="rounded border border-[color:var(--rpc-border)] px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]">
              {series}
            </span>
            {data.tier ? (
              <span
                className={
                  "rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider font-semibold " +
                  tierCls
                }
              >
                {data.tier}
              </span>
            ) : null}
          </div>

          <h1 className="text-3xl font-bold tracking-tight text-[color:var(--rpc-text-primary)] mb-2">
            {data.set_name}
          </h1>
          {data.set_external_id ? (
            <p className="text-xs text-[color:var(--rpc-text-muted)] font-mono">
              External ID · {data.set_external_id}
            </p>
          ) : null}

          <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
                Editions
              </div>
              <div className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums">
                {formatNumber(editionCount)}
              </div>
            </div>
            <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
                Robust total FMV
              </div>
              <div className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums">
                {formatUsd(robustTotal)}
              </div>
              {hasOutlier ? (
                <div
                  className="text-[10px] text-amber-400 mt-1"
                  title="One or more editions have FMV more than 20× the set median; the robust total caps these to 20× median."
                >
                  Outlier capped
                </div>
              ) : null}
            </div>
            <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
                Median FMV
              </div>
              <div className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums">
                {formatUsd(median)}
              </div>
            </div>
            <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
                Raw total FMV
              </div>
              <div className="text-2xl font-bold text-[color:var(--rpc-text-secondary)] tabular-nums">
                {formatUsd(totalRaw)}
              </div>
              <div className="text-[10px] text-[color:var(--rpc-text-muted)] mt-1">
                Pre-cap reference value
              </div>
            </div>
          </div>
        </div>

        <EditionGrid
          editions={editions}
          collection={data.collection}
        />

        <footer className="flex flex-wrap items-center gap-3 text-xs text-[color:var(--rpc-text-muted)] pt-4 border-t border-[color:var(--rpc-border)]">
          <Link
            href="/analytics/methodology/sets"
            className="hover:text-violet-400 transition-colors"
          >
            Methodology
          </Link>
          {data.as_of ? (
            <>
              <span className="text-[color:var(--rpc-text-ghost)]">·</span>
              <span>As of <FreshnessStamp iso={data.as_of} /></span>
            </>
          ) : null}
        </footer>
      </div>
    </>
  )
}

/**
 * Shown when the set detail read FAILED or ran past its budget — never when the
 * set genuinely does not exist (that is still `notFound()`).
 *
 * Deliberately NOT a 404: this page is prerendered, so answering "not found" for
 * a real set during a saturation spell would bake a soft-404 that a crawler
 * believes and that survives until the next revalidate.
 */
function SetUnavailableCard({ setId }: { setId: string }) {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-xl font-semibold text-[var(--rpc-text-primary)]">
        This set&apos;s rollup didn&apos;t load
      </h1>
      <p className="mt-3 text-sm leading-relaxed text-[var(--rpc-text-secondary)]">
        The catalog is under heavy load right now. This says nothing about whether the set
        exists — only that we couldn&apos;t read it. Reload in a moment, or browse the{" "}
        <Link href="/analytics/sets" className="underline">
          full set directory
        </Link>
        .
      </p>
      <p className="mt-6 font-mono text-xs text-[var(--rpc-text-secondary)]">{setId}</p>
    </main>
  )
}
