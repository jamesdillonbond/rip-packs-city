// components/entity/TopFansSection.tsx
//
// Server half of Top Fans (2026-11-27): fetches one get_entity_top_fans read per collection and
// hands the panels to the client table (components/entity/TopFansTable.tsx).
//
// Used by the per-collection team / player / character pages (one panel) and by the aggregated
// hubs (one panel per collection, chips to switch). Stream it under <Suspense> — it never blocks
// or fails the rest of the page.
//
// ⚠ Three states. A panel whose read FAILED stays (it renders "couldn't load"). A panel that was
// measured EMPTY (no rows) is dropped — most players on most collections have no fan RPC can
// see, and a block of "none" on every page is noise, not information. If every panel is measured
// empty, the section renders nothing. That is only correct because the failed state is kept.

import { fetchTopFans, hasFullCollectorCensus, unitsFor, type TopFansPanel } from "@/lib/entity/top-fans"
import type { TopFansTargetSpec } from "@/lib/entity/top-fans-targets"
import TopFansTable from "@/components/entity/TopFansTable"

export type TopFansTarget = TopFansTargetSpec

export async function loadTopFansPanels(targets: TopFansTarget[]): Promise<TopFansPanel[]> {
  const panels = await Promise.all(
    targets.map(async (t): Promise<TopFansPanel> => {
      const base = { collectionId: t.collection.id, urlSlug: t.collection.urlSlug, label: t.collection.displayName, units: unitsFor(t.collection.urlSlug) }
      // No full census → no ranking (a partial one named the wrong #1). Not even read.
      if (!hasFullCollectorCensus(t.collection.urlSlug)) return { ...base, ok: true, data: null, pending: true }
      try {
        const { ok, data } = await fetchTopFans({ collectionId: t.collection.id, kind: t.kind, key: t.key, name: t.name ?? null })
        return { collectionId: t.collection.id, urlSlug: t.collection.urlSlug, label: t.collection.displayName, units: unitsFor(t.collection.urlSlug), ok, data }
      } catch (e) {
        console.error(`[top-fans] ${t.collection.dbSlug} ${t.kind}:${t.key}`, e instanceof Error ? e.message : e)
        return { collectionId: t.collection.id, urlSlug: t.collection.urlSlug, label: t.collection.displayName, units: unitsFor(t.collection.urlSlug), ok: false, data: null }
      }
    }),
  )
  // Drop measured-empty panels only; keep failed (ok:false) and never-built (data:null) ones.
  // Pending panels sort last so a page opens on a real ranking when it has one.
  return panels
    .filter((p) => !(p.ok && p.data && p.data.rows.length === 0))
    .sort((a, b) => Number(a.pending === true) - Number(b.pending === true))
}

export default async function TopFansSection({ targets, subject, title }: { targets: TopFansTarget[]; subject: string; title?: string }) {
  const panels = await loadTopFansPanels(targets)
  if (panels.length === 0) return null
  return <TopFansTable panels={panels} subject={subject} title={title} />
}
