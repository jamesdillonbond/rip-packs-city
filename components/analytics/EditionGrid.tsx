"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import type { FmvConfidence, SetsDetailEdition } from "@/lib/analytics-types"

interface Props {
  editions: SetsDetailEdition[]
  collection: string
}

const TIER_BORDER: Record<string, string> = {
  Common: "border-zinc-500/40 from-zinc-700/30 to-zinc-900/40",
  Fandom: "border-sky-500/40 from-sky-700/20 to-zinc-900/40",
  Rare: "border-cyan-500/40 from-cyan-700/20 to-zinc-900/40",
  Legendary: "border-amber-500/40 from-amber-700/30 to-zinc-900/40",
  Ultimate: "border-rose-500/40 from-rose-700/30 to-zinc-900/40",
}

const TIER_PILL: Record<string, string> = {
  Common: "bg-zinc-500/20 text-zinc-300 border-zinc-500/40",
  Fandom: "bg-sky-500/15 text-sky-300 border-sky-500/40",
  Rare: "bg-cyan-500/15 text-cyan-300 border-cyan-500/40",
  Legendary: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  Ultimate: "bg-rose-500/15 text-rose-300 border-rose-500/40",
}

const CONFIDENCE_PILL: Record<FmvConfidence, string> = {
  HIGH: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  MEDIUM: "border-amber-500/40 bg-amber-500/10 text-amber-400",
  LOW: "border-zinc-600 bg-zinc-800/60 text-zinc-300",
  ASK_ONLY: "border-rose-500/40 bg-rose-500/10 text-rose-400",
}

const CONFIDENCE_LABEL: Record<FmvConfidence, string> = {
  HIGH: "High",
  MEDIUM: "Med",
  LOW: "Low",
  ASK_ONLY: "Ask",
}

// Editions that link to /edition/[id] currently exist for these collections.
// Pinnacle is excluded from Sets, so we don't have to handle it here.
const LINKABLE_COLLECTIONS = new Set(["topshot", "allday", "golazos"])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "No FMV"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

function formatCirculation(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function PlaceholderArt({
  tier,
  name,
}: {
  tier: string | null
  name: string | null
}) {
  const tierKey = tier && tier in TIER_BORDER ? tier : "Common"
  return (
    <div
      className={
        "flex h-32 w-full items-center justify-center rounded-md border bg-gradient-to-br p-3 text-center " +
        (TIER_BORDER[tierKey] ?? TIER_BORDER.Common)
      }
    >
      <span className="text-xs font-semibold text-zinc-200 line-clamp-3">
        {name || "—"}
      </span>
    </div>
  )
}

export default function EditionGrid({ editions, collection }: Props) {
  const [sort, setSort] = useState<"fmv_desc" | "name_asc">("fmv_desc")

  const linkable = LINKABLE_COLLECTIONS.has((collection || "").toLowerCase())

  const sorted = useMemo(() => {
    const copy = [...editions]
    if (sort === "fmv_desc") {
      copy.sort((a, b) => {
        const av = a.fmv_usd ?? -1
        const bv = b.fmv_usd ?? -1
        return bv - av
      })
    } else {
      copy.sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    }
    return copy
  }, [editions, sort])

  if (editions.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">
        This set has no editions in our catalog yet.
      </div>
    )
  }

  return (
    <section>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Editions</h2>
          <p className="text-xs text-zinc-500">
            {editions.length} edition{editions.length === 1 ? "" : "s"} in this
            set
          </p>
        </div>
        <div className="inline-flex rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
          <button
            type="button"
            onClick={() => setSort("fmv_desc")}
            className={
              "px-2.5 py-1 text-xs font-semibold rounded transition-colors " +
              (sort === "fmv_desc"
                ? "bg-violet-500/15 text-violet-300"
                : "text-zinc-400 hover:text-zinc-200")
            }
          >
            FMV
          </button>
          <button
            type="button"
            onClick={() => setSort("name_asc")}
            className={
              "px-2.5 py-1 text-xs font-semibold rounded transition-colors " +
              (sort === "name_asc"
                ? "bg-violet-500/15 text-violet-300"
                : "text-zinc-400 hover:text-zinc-200")
            }
          >
            Name
          </button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {sorted.map((e) => {
          const isLinkable = linkable && UUID_RE.test(e.edition_id || "")
          const tierPill = e.tier && e.tier in TIER_PILL ? e.tier : null
          const inner = (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 transition-colors hover:border-violet-500/30 hover:bg-zinc-900/70 h-full flex flex-col">
              {e.thumbnail_url ? (
                <div className="relative h-32 w-full overflow-hidden rounded-md bg-zinc-950 mb-3">
                  <Image
                    src={e.thumbnail_url}
                    alt={e.name || "edition"}
                    fill
                    className="object-cover"
                    sizes="(max-width: 768px) 50vw, 25vw"
                    unoptimized
                  />
                </div>
              ) : (
                <div className="mb-3">
                  <PlaceholderArt tier={e.tier} name={e.name} />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <span className="font-medium text-zinc-100 line-clamp-2 text-sm">
                    {e.name || "Untitled"}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  {tierPill ? (
                    <span
                      className={
                        "rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
                        TIER_PILL[tierPill]
                      }
                    >
                      {tierPill}
                    </span>
                  ) : null}
                  {e.play_type ? (
                    <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-zinc-400">
                      {e.play_type}
                    </span>
                  ) : null}
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                      Circulation
                    </div>
                    <div className="text-zinc-300 tabular-nums">
                      {formatCirculation(e.circulation_count)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
                      FMV
                    </div>
                    <div
                      className={
                        "tabular-nums font-semibold " +
                        (e.fmv_usd != null ? "text-zinc-100" : "text-zinc-500")
                      }
                    >
                      {formatUsd(e.fmv_usd)}
                    </div>
                  </div>
                </div>
                {e.fmv_confidence ? (
                  <div className="mt-2">
                    <span
                      className={
                        "inline-block rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
                        CONFIDENCE_PILL[e.fmv_confidence]
                      }
                    >
                      {CONFIDENCE_LABEL[e.fmv_confidence]}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          )
          return isLinkable ? (
            <Link key={e.edition_id} href={`/edition/${e.edition_id}`} className="block">
              {inner}
            </Link>
          ) : (
            <div key={e.edition_id || e.edition_external_id || e.name}>
              {inner}
            </div>
          )
        })}
      </div>
    </section>
  )
}
