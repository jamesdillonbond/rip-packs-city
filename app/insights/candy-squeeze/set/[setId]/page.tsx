// app/insights/candy-squeeze/set/[setId]/page.tsx
//
// PUBLIC INSIGHTS — Candy Squeeze for ONE Candy set (2026-11-23, Candy parity pass 3). Every Candy set RPC can vouch
// for — the 2026 registry sets and every legacy collection whose Magic Eden listing sweep is clean, under 12 h old and
// backed by a fully counted census (get_candy_listed_squeeze's eligibility, 20261124032031) — gets a board here, reached
// from the picker on /insights/candy-squeeze.
//
// ISR per set (generated on first visit, then cached 30 min), so a crawler does not run the read per request.
// Honesty:
//  - a malformed set id never reaches the database → 404;
//  - a read that SUCCEEDED and does not list the set among the eligible ones → 404 (RPC cannot vouch for its listings,
//    or it is not a Candy set), never a board reading "0 listed";
//  - a FAILED read renders the degraded notice (200), never a 404 — an outage must not delete a page.
// noindex: these are filtered views of /insights/candy-squeeze (the canonical, indexed board); an unbounded id space
// of indexable 200s is the duplicate-page class the 09-07 Search Console pass removed.

import { cache } from "react"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import CandySqueezeBoard from "@/components/insights/CandySqueezeBoard"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { CANDY_SET_ID_RE, EMPTY_CANDY_SQUEEZE, fetchCandySqueeze } from "@/lib/insights/candy-parity-boards"

export const revalidate = 1800
export const dynamicParams = true
export function generateStaticParams(): Array<{ setId: string }> {
  return []
}

// 25 s, not the shared 8 s (#33). Measured 11-23: ~0.17 s per set (holder counts are precomputed).
const READ_BUDGET_MS = 25_000

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

// One read per render: generateMetadata and the page share it.
const loadSet = cache(async (setId: string) =>
  fetchBoardForPage("Candy squeeze (set)", { ...EMPTY_CANDY_SQUEEZE, set_id: setId }, (db) => fetchCandySqueeze(db, { setId }), READ_BUDGET_MS),
)

export async function generateMetadata({ params }: { params: Promise<{ setId: string }> }): Promise<Metadata> {
  const { setId } = await params
  if (!CANDY_SET_ID_RE.test(setId)) return { robots: { index: false, follow: false } }
  const res = await loadSet(setId)
  // A failed read publishes no set name (the page renders the degraded notice); it never names the wrong set.
  const set = res.ok ? res.data.sets.find((s) => s.set_id === setId) ?? null : null
  const name = set?.set_name ?? "Candy set"
  return {
    // `absolute`: the candy-squeeze layout sets a plain title, so a templated child would not get the brand suffix
    // (R31); this spells it once.
    title: { absolute: `Candy Squeeze · ${name} | Rip Packs City` },
    description: `${name} cards on Candy ranked by how few collector-held copies are listed for sale on Magic Eden — the tightest supply first. Free. No signup.`,
    alternates: { canonical: `${SITE_URL}/insights/candy-squeeze/set/${setId}` },
    robots: { index: false, follow: true },
  }
}

export default async function CandySqueezeSetPage({ params }: { params: Promise<{ setId: string }> }) {
  const { setId } = await params
  if (!CANDY_SET_ID_RE.test(setId)) notFound()
  const res = await loadSet(setId)
  const activeSet = res.data.sets.find((s) => s.set_id === setId) ?? null
  if (res.ok && !activeSet) notFound()
  return <CandySqueezeBoard ok={res.ok} data={res.data} activeSet={activeSet} />
}
