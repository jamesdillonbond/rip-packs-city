# Handoff — Pack Sniper "live feed + Sniper controls" (2026-06-21)

## Context

Goal: make `/insights/pack-sniper` (and the per-collection `/[collection]/pack-sniper` tab) **functionally similar to the regular Sniper** — surface pack deals **as they get listed**, with the Sniper's sort/filter/auto-refresh controls. Trevor greenlit "Live feed + controls" with all four controls (sort dropdown, tier tabs, price/discount filters, 30s auto-refresh + pause).

The blocker for "as they get listed": the Dapper Studio aggregation (`lib/packs/live-pack-listings.ts`) returns **one node per dist with only the lowest ask — no per-listing timestamp**. So recency has to be **synthesized by diffing snapshots over time**.

**Already shipped LIVE by Cowork (DB, project `bxcqstmqfzmuolpuynti`):** migration `audit_20260621_pack_ask_state_table_and_diff_rpc` —
- table `public.pack_ask_state` (one row per `collection_slug`+`dist_id`: `lowest_ask`, `prev_ask`, `ask_first_seen_at`, `ask_changed_at`, `last_checked_at`, `is_listed`). RLS on; anon/auth **SELECT-only**; service_role full. Index `idx_pack_ask_state_listed_recency (collection_slug, is_listed, ask_changed_at DESC)`.
- SECDEF RPC `public.upsert_pack_ask_state(p_collection_slug text, p_listings jsonb)` (service_role/postgres EXECUTE only) — diffs a fresh snapshot against current state: inserts brand-new / re-listed dists (NEW), records `prev_ask` + bumps `ask_changed_at` on a price change, refreshes `last_checked_at` on no-change, and marks dists that left the live book `is_listed=false`. Returns `{total_listed,new,changed,dropped,at}`.
- Verified live: `check_public_security_invariants()` = 0, `check_secdef_anon_execute_violations()` = `[]`. Diff logic smoke-tested end-to-end (new / price-drop `prev_ask` / unlist transitions all correct) and the smoke rows deleted.

**This handoff covers the code Cowork can't push** (route + lib + .tsx): the snapshot **writer cron**, the **reader** recency join, the **client UI** (controls + NEW/▼ badges), two tiny page edits, and the operator cron wiring. `pack_ask_state` is empty until the writer cron runs — the reader LEFT-JOINs it, so until then the board behaves exactly as today (recency fields null → value-ordered). Nothing half-breaks.

> **Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** (Paths below were grepped/read live on 2026-06-21, but verify before pasting.)

---

## Guardrails (repeat every handoff)

- **Direct-to-`main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op). Re-verify the push: `git rev-list --count origin/main..HEAD` → expect `0`.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s** — higher sends the deploy to ERROR invisibly. (Our cron uses 120.)
- CRLF: don't string-replace-patch on Windows — use full-file writes (all three code files below are full replacements).
- After deploy: `npx tsc --noEmit` clean; the Vercel deploy reaches READY; smoke `/api/public/insights/pack-sniper`, `/insights/pack-sniper`, `/api/og/insights/pack-sniper` (all 200).

---

## Item 1 — NEW writer cron `app/api/cron/snapshot-pack-asks/route.ts`

**Why:** owns the fresh upstream pull and feeds `upsert_pack_ask_state` so the board has a real recency signal. `force:true` bypasses the 2-min in-lambda memo so each tick sees the freshest book (the public board's read path keeps the memoized fetch — this writer does the fresh pulls). `202 + after()` so a slow Dapper fetch never trips cron-job.org's 30s client cap; `pipeline_runs` (`snapshot-pack-asks`) is the real signal. Mirrors `app/api/cron/refresh-conflated-editions/route.ts`.

Create the file with exactly this content:

```ts
import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchLivePackListings, SUPPORTED_PACK_COLLECTIONS } from "@/lib/packs/live-pack-listings"

// Snapshots the live sealed-pack lowest-ask per dist into public.pack_ask_state
// so the Pack Sniper can show a real "just listed / price dropped" recency
// signal (parity with the regular Sniper's "Recently Listed" sort). The Dapper
// Studio aggregation returns one node per dist with NO per-listing timestamp,
// so the only way to know "as they get listed" is to diff snapshots over time —
// which is exactly what the SECDEF RPC upsert_pack_ask_state does, atomically,
// per collection (migration audit_20260621_pack_ask_state_table_and_diff_rpc).
//
// Auth: Bearer INGEST_SECRET_TOKEN. 202 + after() so a slow upstream fetch never
// trips cron-job.org's 30s client cap (pipeline_runs is the real signal).
//
// Operator: wire a cron-job.org entry (www.rippackscity.com, ~every 5 min) with
// Authorization: Bearer <INGEST_SECRET_TOKEN>. Cadence is the freshness lever
// (cost-flat: 2-3 min for snappier "as they get listed", 5+ for lighter egress).

export const dynamic = "force-dynamic"
export const maxDuration = 120

const PIPELINE_NAME = "snapshot-pack-asks"

async function run(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAt = new Date().toISOString()

  after(async () => {
    const startedMs = Date.now()
    let ok = true
    let errMsg: string | null = null
    const perCollection: Record<string, unknown> = {}
    let totalListed = 0
    let totalNew = 0
    let totalChanged = 0
    let totalDropped = 0

    for (const collection of SUPPORTED_PACK_COLLECTIONS) {
      try {
        // force:true bypasses the 2-min in-lambda memo so each tick sees the
        // freshest upstream book (the public board's read path keeps the memo).
        const { listings } = await fetchLivePackListings(collection, { force: true })
        const payload = listings
          .filter((l) => l.lowestAsk > 0)
          .map((l) => ({
            dist_id: l.distId,
            pack_listing_id: l.packListingId,
            lowest_ask: l.lowestAsk,
          }))

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabaseAdmin as any).rpc("upsert_pack_ask_state", {
          p_collection_slug: collection,
          p_listings: payload,
        })

        if (error) {
          ok = false
          errMsg = `${collection}: ${error.message}`
          perCollection[collection] = { error: error.message }
        } else {
          const r = (data ?? {}) as {
            total_listed?: number; new?: number; changed?: number; dropped?: number
          }
          perCollection[collection] = r
          totalListed += Number(r.total_listed ?? 0)
          totalNew += Number(r.new ?? 0)
          totalChanged += Number(r.changed ?? 0)
          totalDropped += Number(r.dropped ?? 0)
        }
      } catch (e) {
        ok = false
        errMsg = `${collection}: ${e instanceof Error ? e.message : String(e)}`
        perCollection[collection] = { error: errMsg }
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAt,
        p_rows_found: totalListed,
        p_rows_written: totalNew + totalChanged,
        p_rows_skipped: totalDropped,
        p_ok: ok,
        p_error: errMsg,
        p_extra: { duration_ms: Date.now() - startedMs, per_collection: perCollection },
      })
    } catch (logErr) {
      console.log(
        `[${PIPELINE_NAME}] log_pipeline_run err: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
      )
    }
  })

  return NextResponse.json({ ok: true, accepted: true, pipeline: PIPELINE_NAME }, { status: 202 })
}

export async function POST(request: NextRequest) {
  return run(request)
}

export async function GET(request: NextRequest) {
  return run(request)
}
```

**Verify `supabaseAdmin` import:** `lib/packs/pack-deals.ts` already imports `{ supabaseAdmin } from "@/lib/supabase"` — reuse the same. If your local `@/lib/supabase` export name differs, match it (CC's file inspection wins).

**Revert:** delete the file + remove the cron-job.org entry.

---

## Item 2 — reader recency join `lib/packs/pack-deals.ts` (FULL REPLACEMENT)

**Why:** LEFT-JOIN `pack_ask_state` (the `is_listed=true` rows) by `dist_id`, add the recency fields to `PackDeal`, and change the default return order to **recency** (`ask_changed_at` desc, value tie-break) so the server-rendered order matches the client's default "Recently Listed" sort (no hydration mismatch). The `pack_ask_state` read is **non-fatal** — recency is an overlay; if it errors the board still serves value-ordered deals. The live ask / title / image / EV are unchanged (still the live fetch + `pack_table_rows`); `pack_ask_state` only adds the "how long has this ask been here / did it just drop" overlay.

Replace the whole file with:

```ts
// lib/packs/pack-deals.ts
//
// PACK SNIPER deal feed — the shared server-side logic that joins LIVE sealed-pack
// secondary asks (Dapper Studio, via lib/packs/live-pack-listings.ts) to the
// pack EV view (pack_table_rows) and applies honesty gates, then orders the deal
// set by RECENCY (ask changed-at) with value as the tie-break.
//
// Consumed by:
//   - app/api/public/insights/pack-sniper/route.ts  (public board data source)
//   - app/insights/pack-sniper/page.tsx             (server-rendered default view)
//   - app/(collections)/[collection]/pack-sniper/page.tsx
//
// RECENCY OVERLAY (2026-06-21). The Dapper Studio aggregation has no per-listing
// timestamp, so /api/cron/snapshot-pack-asks diffs the live book over time into
// public.pack_ask_state. This module LEFT-JOINs that state (is_listed=true) to
// flag NEW / price-dropped packs and to order the board "as they get listed".
// The join is non-fatal: before the snapshot cron runs (or if it errors) the
// recency fields are null and the board degrades to value order. This module
// only READS pack_table_rows + pack_ask_state; it changes no EV/FMV/pricing.
//
// RANK, DON'T PRICE (2026-05-29 research thread). gross_ev is a drop-weighted
// EXPECTATION, not a typical outcome. For chance-hit / single-chase packs the
// distribution is wildly skewed, so we:
//   1. NEVER score against the cached/stale view ask — always the live ask.
//   2. Flag high-variance packs (gross_ev > 3 × ask, depletion >= 60,
//      coverage < 80, single-slot chase). The board hides these by default.
//   3. Surface the FMV-coverage chip + a simulator link on every row.

import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchLivePackListings,
  isSupportedPackCollection,
  type PackCollectionSlug,
} from "@/lib/packs/live-pack-listings"
import { topshotPackUrl, dapperMarketPackUrl } from "@/lib/pack-urls"

export type PackDeal = {
  distId: string
  title: string
  tier: string
  imageUrl: string
  slots: number
  lowestAsk: number
  grossEV: number
  /** gross_ev / live lowest ask. > 1 means EV exceeds the live ask. */
  liveValueRatio: number
  /** 1 - (ask / gross_ev), clamped to [0,1). */
  discountPct: number
  fmvCoveragePct: number
  evSnapshottedAt: string | null
  editionCount: number | null
  depletionPct: number | null
  highVariance: boolean
  highVarianceReasons: string[]
  buyUrl: string
  dapperUrl: string
  detailHref: string
  simulatorHref: string
  // ── Recency overlay (from pack_ask_state; null until the snapshot cron runs) ──
  /** When this dist's lowest ask last changed (new listing or price move). Drives "Recently Listed". */
  askChangedAt: string | null
  /** When this dist's current listed run began (reset when it re-lists after going unlisted). */
  askFirstSeenAt: string | null
  /** The lowest ask immediately before the most recent change (enables the ▼ badge). */
  prevAsk: number | null
  /** Listed (or re-listed) within RECENCY_WINDOW. */
  isNew: boolean
  /** Lowest ask dropped vs prevAsk within RECENCY_WINDOW (and not brand-new). */
  isPriceDrop: boolean
  /** 1 - (ask / prevAsk) when isPriceDrop, else null. */
  askDropPct: number | null
}

export type PackDealsResult = {
  collection: PackCollectionSlug
  deals: PackDeal[]
  stats: {
    liveListings: number
    gatedEvRows: number
    matched: number
    positiveEv: number
    highVariance: number
    returned: number
  }
}

const MIN_FMV_COVERAGE = 80
const EV_FRESH_HOURS = 72
const MAX_DEPLETION_PCT = 90

const HIGH_VARIANCE_RATIO = 3
const HIGH_VARIANCE_DEPLETION = 60

// How long a freshly-listed / price-dropped pack wears its NEW / ▼ badge. The
// snapshot cron resolves changes at its cadence (~5m); this is the display
// window, not the detection resolution.
const RECENCY_WINDOW_MS = 120 * 60 * 1000

type EvRow = {
  dist_id: string
  gross_ev: number | null
  fmv_coverage_pct: number | null
  ev_snapshotted_at: string | null
  is_rare_single_pack: boolean | null
  depletion_pct: number | null
  edition_count: number | null
  slots: number | null
}

type AskStateRow = {
  dist_id: string
  lowest_ask: number | null
  prev_ask: number | null
  ask_first_seen_at: string | null
  ask_changed_at: string | null
}

function leagueFor(collection: PackCollectionSlug): "nba" | "nfl" {
  return collection === "nfl-all-day" ? "nfl" : "nba"
}

function buyUrlFor(
  collection: PackCollectionSlug,
  distId: string,
  packListingId: string,
): string {
  if (collection === "nfl-all-day") {
    return dapperMarketPackUrl({ league: "nfl", distId })
  }
  const uuid = packListingId && packListingId !== distId ? packListingId : null
  return topshotPackUrl({ distId, packListingUuid: uuid })
}

/**
 * Build the recency-ordered Pack Sniper deal feed for a collection.
 *
 * @param collection  "nba-top-shot" | "nfl-all-day"
 * @param opts.limit  max deals to return (default 50, capped 200)
 * @param opts.includeHighVariance  when false, high-variance packs are dropped.
 */
export async function getPackDeals(
  collection: string,
  opts: { limit?: number; includeHighVariance?: boolean } = {},
): Promise<PackDealsResult> {
  if (!isSupportedPackCollection(collection)) {
    throw new Error(`Unsupported collection '${collection}'`)
  }
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50))
  const includeHighVariance = opts.includeHighVariance ?? true

  const evCutoff = new Date(Date.now() - EV_FRESH_HOURS * 3600 * 1000).toISOString()

  // Pull live listings + gated EV rows + recency state in parallel.
  const [{ listings }, evRes, askRes] = await Promise.all([
    fetchLivePackListings(collection),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("pack_table_rows")
      .select(
        "dist_id, gross_ev, fmv_coverage_pct, ev_snapshotted_at, is_rare_single_pack, depletion_pct, edition_count, slots",
      )
      .eq("collection_slug", collection)
      .not("gross_ev", "is", null)
      .gte("fmv_coverage_pct", MIN_FMV_COVERAGE)
      .eq("is_rare_single_pack", false)
      .gte("ev_snapshotted_at", evCutoff)
      .lt("depletion_pct", MAX_DEPLETION_PCT)
      .limit(2000),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("pack_ask_state")
      .select("dist_id, lowest_ask, prev_ask, ask_first_seen_at, ask_changed_at")
      .eq("collection_slug", collection)
      .eq("is_listed", true)
      .limit(5000),
  ])

  if (evRes.error) {
    throw new Error(`pack_table_rows read failed: ${evRes.error.message}`)
  }

  const evByDist = new Map<string, EvRow>()
  for (const row of (evRes.data ?? []) as EvRow[]) {
    if (row.dist_id) evByDist.set(String(row.dist_id), row)
  }

  // Recency overlay is non-fatal — a read error just means no NEW/▼ flags today.
  const askByDist = new Map<string, AskStateRow>()
  if (!askRes?.error) {
    for (const row of (askRes?.data ?? []) as AskStateRow[]) {
      if (row.dist_id) askByDist.set(String(row.dist_id), row)
    }
  }

  let matched = 0
  let positiveEv = 0
  let highVarianceCount = 0
  const deals: PackDeal[] = []
  const nowMs = Date.now()

  for (const lst of listings) {
    if (lst.lowestAsk <= 0) continue
    const ev = evByDist.get(String(lst.distId))
    if (!ev || ev.gross_ev == null) continue
    matched += 1

    const grossEV = Number(ev.gross_ev)
    const liveValueRatio = grossEV / lst.lowestAsk
    if (!(liveValueRatio > 1)) continue
    positiveEv += 1

    const coverage = ev.fmv_coverage_pct ?? 0
    const depletion = ev.depletion_pct ?? 0
    const slots = lst.momentsPerPack ?? ev.slots ?? 1

    const reasons: string[] = []
    if (liveValueRatio > HIGH_VARIANCE_RATIO) reasons.push("ev_gt_3x_ask")
    if (depletion >= HIGH_VARIANCE_DEPLETION) reasons.push("depleted_60pct")
    if (coverage < 80) reasons.push("thin_fmv_coverage")
    if (slots <= 1) reasons.push("single_slot_chase")
    const highVariance = reasons.length > 0
    if (highVariance) highVarianceCount += 1

    if (!includeHighVariance && highVariance) continue

    // ── Recency overlay ──
    const askState = askByDist.get(String(lst.distId))
    const askChangedAt = askState?.ask_changed_at ?? null
    const askFirstSeenAt = askState?.ask_first_seen_at ?? null
    const prevAsk = askState?.prev_ask != null ? Number(askState.prev_ask) : null
    const firstSeenMs = askFirstSeenAt ? Date.parse(askFirstSeenAt) : NaN
    const changedMs = askChangedAt ? Date.parse(askChangedAt) : NaN
    const isNew = Number.isFinite(firstSeenMs) && nowMs - firstSeenMs <= RECENCY_WINDOW_MS
    const isPriceDrop =
      !isNew &&
      prevAsk != null &&
      lst.lowestAsk < prevAsk &&
      Number.isFinite(changedMs) &&
      nowMs - changedMs <= RECENCY_WINDOW_MS
    const askDropPct =
      isPriceDrop && prevAsk ? Math.max(0, Math.min(0.9999, 1 - lst.lowestAsk / prevAsk)) : null

    deals.push({
      distId: lst.distId,
      title: lst.title,
      tier: lst.tier,
      imageUrl: lst.imageUrl,
      slots,
      lowestAsk: lst.lowestAsk,
      grossEV,
      liveValueRatio,
      discountPct: Math.max(0, Math.min(0.9999, 1 - lst.lowestAsk / grossEV)),
      fmvCoveragePct: coverage,
      evSnapshottedAt: ev.ev_snapshotted_at,
      editionCount: ev.edition_count,
      depletionPct: ev.depletion_pct,
      highVariance,
      highVarianceReasons: reasons,
      buyUrl: buyUrlFor(collection, lst.distId, lst.packListingId),
      dapperUrl: dapperMarketPackUrl({ league: leagueFor(collection), distId: lst.distId }),
      detailHref: `/${collection}/pack/dist/${lst.distId}`,
      simulatorHref: `/${collection}/packs/simulator/${lst.distId}`,
      askChangedAt,
      askFirstSeenAt,
      prevAsk,
      isNew,
      isPriceDrop,
      askDropPct,
    })
  }

  // Default order = recency ("as they get listed"): most-recently-changed ask
  // first, value as the tie-break. Before the snapshot cron populates
  // pack_ask_state every ask_changed_at is null -> this degrades to value order.
  // The client re-sorts the returned set for the other sort options, so as long
  // as `limit` (>= 200 from the callers) exceeds the deal count it has the full
  // set to sort. If the deal count ever exceeds the limit, the LEAST-recent
  // deals are dropped — raise the caller limit if that ever bites.
  deals.sort((a, b) => {
    const at = a.askChangedAt ? Date.parse(a.askChangedAt) : 0
    const bt = b.askChangedAt ? Date.parse(b.askChangedAt) : 0
    if (bt !== at) return bt - at
    return b.liveValueRatio - a.liveValueRatio
  })
  const returned = deals.slice(0, limit)

  return {
    collection,
    deals: returned,
    stats: {
      liveListings: listings.length,
      gatedEvRows: evByDist.size,
      matched,
      positiveEv,
      highVariance: highVarianceCount,
      returned: returned.length,
    },
  }
}
```

**Revert:** `git revert` the commit (restores the value-only sort + the pre-recency `PackDeal`). The `pack_ask_state` table can stay (inert).

---

## Item 3 — page edits (raise the returned set to 200)

So the client has the full deal set to sort/filter locally (recency default → value/cheapest/etc. on demand). Two one-line edits:

`app/insights/pack-sniper/page.tsx` — in `fetchInitial()`:
```ts
const res = await getPackDeals("nba-top-shot", { limit: 200, includeHighVariance: false })
```
(was `limit: 100`)

`app/(collections)/[collection]/pack-sniper/page.tsx` — in the try block:
```ts
const res = await getPackDeals(collection, { limit: 200, includeHighVariance: false })
```
(was `limit: 100`)

The API route `app/api/public/insights/pack-sniper/route.ts` already clamps `limit` to `Math.min(200, …)`; **optionally** lower its cache so the 30s auto-refresh feels live (the in-lambda 2-min memo still bounds Dapper hits, so this is safe):
```ts
res.headers.set("Cache-Control", "public, s-maxage=60, stale-while-revalidate=30")
```
(was `s-maxage=300, stale-while-revalidate=60`). Optional but recommended.

**Revert:** restore `100` / `s-maxage=300`.

---

## Item 4 — client UI `app/insights/pack-sniper/PackSniperClient.tsx` (FULL REPLACEMENT)

Adds: **sort dropdown** (Recently Listed default / Biggest Price Drop / Best EV÷Ask / Cheapest / Highest EV), **tier filter tabs** (built dynamically from the loaded deals), **max-ask + min-EV/ask filters**, **30s auto-refresh countdown + Pause/Resume + Refresh-now**, and **NEW / ▼ price-drop badges + relative "listed Xm ago"** per row. Sort + tier + price filters are **client-side** over the loaded set (instant, no refetch); refetch happens on collection change, the high-variance toggle, the 30s timer, and Refresh-now. Keeps the RANK-DON'T-PRICE framing and adds an honest note that recency is snapshot-derived. Brand tokens only (`--rpc-success` green = NEW, `--rpc-warning` amber = ▼). No URL params (controls are client state) → no new canonical/duplicate-content surface.

Replace the whole file with:

```tsx
"use client"

// app/insights/pack-sniper/PackSniperClient.tsx
//
// Client interactivity for the public Pack Sniper deal board. The server
// component fetches the default view (honest deals only, recency-ordered) and
// passes it as initialDeals so the ranked table + links render in the raw
// server HTML (crawlable). This layer adds the Sniper-style controls (sort,
// tier tabs, price/discount filters, 30s auto-refresh + pause) and the
// "as they get listed" recency badges (NEW / ▼ price drop).
//
// RANK, DON'T PRICE: ordering + "ask $X vs EV $Y", never a headline "92x".
// High-variance (chance-hit / single-chase / depleted) packs are hidden by
// default and revealed flagged. Every row links to the simulator.
//
// Recency note: "Recently Listed" + NEW/▼ come from RPC's own snapshots of the
// live pack book (every few min), NOT an exact on-chain listing timestamp —
// Top Shot's pack API doesn't expose one. Honest framing in the methodology.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import TrackedOutboundLink from "@/components/TrackedOutboundLink"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const REFRESH_INTERVAL = 30

export type Deal = {
  distId: string
  title: string
  tier: string
  imageUrl: string
  slots: number
  lowestAsk: number
  grossEV: number
  liveValueRatio: number
  discountPct: number
  fmvCoveragePct: number
  evSnapshottedAt: string | null
  editionCount: number | null
  depletionPct: number | null
  highVariance: boolean
  highVarianceReasons: string[]
  buyUrl: string
  dapperUrl: string
  detailHref: string
  simulatorHref: string
  askChangedAt: string | null
  askFirstSeenAt: string | null
  prevAsk: number | null
  isNew: boolean
  isPriceDrop: boolean
  askDropPct: number | null
}

type ApiResponse = {
  meta: { fetched_at: string; collection: string; stats?: { returned: number } }
  deals: Deal[]
}

type Collection = "nba-top-shot" | "nfl-all-day"

const COLLECTION_LABEL: Record<Collection, string> = {
  "nba-top-shot": "NBA Top Shot",
  "nfl-all-day": "NFL All Day",
}

type SortKey = "recent" | "drop" | "value" | "cheap" | "ev"

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: "recent", label: "Recently Listed" },
  { value: "drop", label: "Biggest Price Drop" },
  { value: "value", label: "Best EV / Ask" },
  { value: "cheap", label: "Cheapest Ask" },
  { value: "ev", label: "Highest EV" },
]

const TIER_RANK: Record<string, number> = {
  common: 0,
  fandom: 1,
  rare: 2,
  legendary: 3,
  ultimate: 4,
}

function recencyMs(d: Deal): number {
  const t = d.askChangedAt ? Date.parse(d.askChangedAt) : NaN
  return Number.isFinite(t) ? t : 0
}

const SORTERS: Record<SortKey, (a: Deal, b: Deal) => number> = {
  recent: (a, b) => recencyMs(b) - recencyMs(a) || b.liveValueRatio - a.liveValueRatio,
  drop: (a, b) => (b.askDropPct ?? -1) - (a.askDropPct ?? -1) || recencyMs(b) - recencyMs(a),
  value: (a, b) => b.liveValueRatio - a.liveValueRatio,
  cheap: (a, b) => a.lowestAsk - b.lowestAsk,
  ev: (a, b) => b.grossEV - a.grossEV,
}

function fmtUsd(n: number | null): string {
  if (n == null) return "—"
  const v = Number(n)
  if (v >= 1000) return `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`
  if (v >= 100) return `$${v.toFixed(0)}`
  return `$${v.toFixed(2)}`
}

function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return "—"
  if (n >= 100) return `${Math.round(n)}×`
  if (n >= 10) return `${n.toFixed(0)}×`
  return `${n.toFixed(1)}×`
}

function relTime(iso: string | null): string {
  if (!iso) return ""
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ""
  const m = Math.floor(ms / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function tierColor(tier: string | null): string {
  switch ((tier ?? "").toLowerCase()) {
    case "legendary":
      return "var(--tier-legendary)"
    case "ultimate":
      return "var(--tier-ultimate)"
    case "rare":
      return "var(--tier-rare)"
    case "fandom":
      return "var(--tier-fandom)"
    case "common":
      return "var(--tier-common)"
    default:
      return "var(--rpc-text-muted)"
  }
}

const VARIANCE_REASON_LABEL: Record<string, string> = {
  ev_gt_3x_ask: "EV > 3× ask (tail-driven)",
  depleted_60pct: "60%+ depleted",
  thin_fmv_coverage: "thin FMV coverage",
  single_slot_chase: "single-slot chase",
}

type Props = {
  initialDeals: Deal[]
  initialFetchedAt: string | null
  lockedCollection?: Collection
}

export default function PackSniperClient({ initialDeals, initialFetchedAt, lockedCollection }: Props) {
  const [collection, setCollection] = useState<Collection>(lockedCollection ?? "nba-top-shot")
  const [showHighVariance, setShowHighVariance] = useState(false)
  const [deals, setDeals] = useState<Deal[]>(initialDeals)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fetchedAt, setFetchedAt] = useState<string | null>(initialFetchedAt)

  // Sniper-style controls.
  const [sortBy, setSortBy] = useState<SortKey>("recent")
  const [tierTab, setTierTab] = useState<string>("all")
  const [maxAsk, setMaxAsk] = useState(0)
  const [minRatio, setMinRatio] = useState(0)
  const [paused, setPaused] = useState(false)
  const [countdown, setCountdown] = useState(REFRESH_INTERVAL)

  // Time-sensitive relative labels (relTime) are client-only so SSR and the
  // first hydration render don't disagree at minute boundaries.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  // Out-of-order guard (newer fetch supersedes older) without AbortController.
  const reqIdRef = useRef(0)
  const fetchDeals = useCallback(async () => {
    const myId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      params.set("collection", collection)
      params.set("limit", "200")
      params.set("include_high_variance", showHighVariance ? "true" : "false")
      const r = await fetch(`/api/public/insights/pack-sniper?${params.toString()}`, {
        cache: "no-store",
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const j = (await r.json()) as ApiResponse
      if (myId !== reqIdRef.current) return
      setDeals(j.deals ?? [])
      setFetchedAt(j.meta?.fetched_at ?? null)
    } catch (e: unknown) {
      if (myId !== reqIdRef.current) return
      setError(e instanceof Error ? e.message : "Failed to load")
    } finally {
      if (myId === reqIdRef.current) setLoading(false)
    }
  }, [collection, showHighVariance])

  // Refetch on collection / high-variance change, skipping the server-rendered
  // default (locked collection if set, else Top Shot; high-variance hidden).
  const isFirstRun = useRef(true)
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false
      if (collection === (lockedCollection ?? "nba-top-shot") && !showHighVariance) return
    }
    fetchDeals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collection, showHighVariance])

  // Auto-refresh: reset the countdown whenever a fetch was just triggered, and
  // tick it down once a second; on 0 refetch (unless paused).
  useEffect(() => {
    setCountdown(REFRESH_INTERVAL)
  }, [collection, showHighVariance])

  useEffect(() => {
    if (paused) return
    const id = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          fetchDeals()
          return REFRESH_INTERVAL
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [paused, fetchDeals])

  // Tier tabs reflect only the tiers actually present in the loaded set.
  const availableTiers = useMemo(() => {
    const set = new Set<string>()
    for (const d of deals) {
      const t = (d.tier || "").toLowerCase()
      if (t) set.add(t)
    }
    return Array.from(set).sort((a, b) => (TIER_RANK[a] ?? 99) - (TIER_RANK[b] ?? 99))
  }, [deals])

  // Filter + sort happen client-side over the loaded set (instant, no refetch).
  const processed = useMemo(() => {
    let rows = showHighVariance ? deals : deals.filter((d) => !d.highVariance)
    if (tierTab !== "all") rows = rows.filter((d) => (d.tier || "").toLowerCase() === tierTab)
    if (maxAsk > 0) rows = rows.filter((d) => d.lowestAsk <= maxAsk)
    if (minRatio > 1) rows = rows.filter((d) => d.liveValueRatio >= minRatio)
    return [...rows].sort(SORTERS[sortBy])
  }, [deals, showHighVariance, tierTab, maxAsk, minRatio, sortBy])

  const kpis = useMemo(() => {
    const hiddenHiVar = showHighVariance ? 0 : deals.filter((d) => d.highVariance).length
    if (processed.length === 0) return { count: 0, medianRatio: 0, bestRatio: 0, newCount: 0, hiddenHiVar }
    const ratios = processed.map((d) => d.liveValueRatio).sort((a, b) => a - b)
    const mid = Math.floor(ratios.length / 2)
    const medianRatio = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2
    const newCount = processed.filter((d) => d.isNew).length
    return { count: processed.length, medianRatio, bestRatio: ratios[ratios.length - 1], newCount, hiddenHiVar }
  }, [processed, deals, showHighVariance])

  const tweetIntent = useMemo(() => {
    const text = `Top Shot shows a sealed pack's low ask. We show the ask vs the pack's expected pull value — and flag packs as they get listed.\n\nThe Pack Sniper:`
    return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(
      `${SITE_URL}/insights/pack-sniper`,
    )}`
  }, [])

  const updatedLabel = fetchedAt
    ? new Date(fetchedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
    : "—"

  return (
    <main style={lockedCollection ? styles.pageEmbedded : styles.page}>
      <style>{CSS}</style>

      {lockedCollection ? (
        <section className="rpc-ps-hero rpc-ps-hero-compact">
          <h1 className="rpc-ps-h1 rpc-ps-h1-compact">
            The Pack Sniper <span className="rpc-ps-h1-coll">— {COLLECTION_LABEL[collection]}</span>
          </h1>
          <p className="rpc-ps-lede">
            Sealed {COLLECTION_LABEL[collection]} packs listed below their{" "}
            <strong>expected pull value</strong>, surfaced <em>as they get listed</em>. We rank{" "}
            <em>ask vs EV</em> — the ordering is the signal, not the number.
          </p>
          <div className="rpc-ps-meta-row">
            <span className="rpc-ps-meta">Updated {updatedLabel}</span>
            <span className="rpc-ps-meta-sep">·</span>
            <span className="rpc-ps-meta">Live asks · auto-refresh</span>
          </div>
        </section>
      ) : (
        <section className="rpc-ps-hero">
          <div className="rpc-ps-eyebrow">RPC Insights · Public</div>
          <h1 className="rpc-ps-h1">The Pack Sniper</h1>
          <p className="rpc-ps-lede">
            Top Shot&apos;s marketplace shows you a sealed pack&apos;s <em>low ask</em>. We show that
            ask against the pack&apos;s <strong>expected pull value</strong> — and flag packs{" "}
            <em>as they get listed</em> or drop in price, so you can catch a deal before the market
            does.
          </p>
          <div className="rpc-ps-meta-row">
            <span className="rpc-ps-meta">Updated {updatedLabel}</span>
            <span className="rpc-ps-meta-sep">·</span>
            <span className="rpc-ps-meta">Live asks · auto-refresh</span>
            <span className="rpc-ps-meta-sep">·</span>
            <span className="rpc-ps-meta">No signup</span>
          </div>
        </section>
      )}

      {/* ── Controls ──────────────────────────────────────────────────── */}
      <section className="rpc-ps-controls" aria-label="Controls">
        {!lockedCollection && (
          <div className="rpc-ps-pill-group" role="tablist" aria-label="Collection">
            {(Object.keys(COLLECTION_LABEL) as Collection[]).map((c) => (
              <button
                key={c}
                role="tab"
                aria-selected={collection === c}
                className={`rpc-ps-pill ${collection === c ? "rpc-ps-pill-active" : ""}`}
                onClick={() => setCollection(c)}
              >
                {COLLECTION_LABEL[c]}
              </button>
            ))}
          </div>
        )}

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Sort</span>
          <select
            className="rpc-ps-select"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as SortKey)}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>

        {availableTiers.length > 0 && (
          <div className="rpc-ps-pill-group" role="tablist" aria-label="Tier">
            <button
              role="tab"
              aria-selected={tierTab === "all"}
              className={`rpc-ps-pill ${tierTab === "all" ? "rpc-ps-pill-active" : ""}`}
              onClick={() => setTierTab("all")}
            >
              All tiers
            </button>
            {availableTiers.map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tierTab === t}
                className={`rpc-ps-pill ${tierTab === t ? "rpc-ps-pill-active" : ""}`}
                onClick={() => setTierTab(t)}
              >
                {t.toUpperCase()}
              </button>
            ))}
          </div>
        )}

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Max ask $</span>
          <input
            className="rpc-ps-input"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="any"
            value={maxAsk || ""}
            onChange={(e) => setMaxAsk(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>

        <label className="rpc-ps-field">
          <span className="rpc-ps-field-label">Min EV / ask</span>
          <input
            className="rpc-ps-input"
            type="number"
            min={1}
            step={0.1}
            inputMode="decimal"
            placeholder="1.0×"
            value={minRatio || ""}
            onChange={(e) => setMinRatio(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>

        <label className="rpc-ps-toggle">
          <input
            type="checkbox"
            checked={showHighVariance}
            onChange={(e) => setShowHighVariance(e.target.checked)}
          />
          <span>
            High-variance packs{kpis.hiddenHiVar > 0 ? ` (${kpis.hiddenHiVar} hidden)` : ""}
          </span>
        </label>

        <div className="rpc-ps-refresh">
          <span className="rpc-ps-countdown">{paused ? "paused" : `↻ ${countdown}s`}</span>
          <button
            className="rpc-ps-refresh-btn"
            onClick={() => setPaused((p) => !p)}
            aria-pressed={paused}
          >
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            className="rpc-ps-refresh-btn"
            onClick={() => {
              setCountdown(REFRESH_INTERVAL)
              fetchDeals()
            }}
          >
            Refresh now
          </button>
        </div>
      </section>

      {/* ── KPI strip ─────────────────────────────────────────────────── */}
      <section className="rpc-ps-kpi-row" aria-label="Summary">
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Deals shown</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : kpis.count}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Just listed (2h)</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : kpis.newCount}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Median EV / ask</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : fmtRatio(kpis.medianRatio)}</div>
        </div>
        <div className="rpc-ps-kpi">
          <div className="rpc-ps-kpi-label">Best EV / ask</div>
          <div className="rpc-ps-kpi-value">{loading ? "—" : fmtRatio(kpis.bestRatio)}</div>
        </div>
      </section>

      {/* ── Table ─────────────────────────────────────────────────────── */}
      <section className="rpc-ps-table-wrap" aria-label="Pack deals">
        {error ? (
          <div className="rpc-ps-state">Failed to load: {error}</div>
        ) : loading ? (
          <div className="rpc-ps-state">Loading…</div>
        ) : processed.length === 0 ? (
          <div className="rpc-ps-state">
            No sealed packs match your filters
            {tierTab !== "all" || maxAsk > 0 || minRatio > 1 ? " (try loosening them)" : ""}
            {!showHighVariance ? " — or show high-variance packs" : ""}. The market is efficient
            right now — check back as new packs get listed.
          </div>
        ) : (
          <table className="rpc-ps-table">
            <thead>
              <tr>
                <th className="rpc-ps-th-pack">Pack</th>
                <th className="rpc-ps-th-num">Tier</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">Live ask</th>
                <th className="rpc-ps-th-num">Gross EV</th>
                <th className="rpc-ps-th-num rpc-ps-th-emph">EV / ask</th>
                <th className="rpc-ps-th-num">FMV cov.</th>
                <th className="rpc-ps-th-act">Actions</th>
              </tr>
            </thead>
            <tbody>
              {processed.map((d) => (
                <tr key={`${collection}-${d.distId}`} className="rpc-ps-row">
                  <td className="rpc-ps-td-pack">
                    <Link href={d.detailHref} className="rpc-ps-pack-link">
                      {d.imageUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={d.imageUrl} alt={d.title} className="rpc-ps-pack-img" loading="lazy" />
                      ) : (
                        <div className="rpc-ps-pack-img rpc-ps-pack-img-empty" aria-hidden="true" />
                      )}
                      <span className="rpc-ps-pack-meta">
                        <span className="rpc-ps-pack-title">{d.title.trim() || "—"}</span>
                        <span className="rpc-ps-pack-sub">
                          <span>
                            {d.slots} {d.slots === 1 ? "slot" : "slots"}
                          </span>
                          {d.isNew ? (
                            <span className="rpc-ps-new-chip">NEW</span>
                          ) : d.isPriceDrop ? (
                            <span
                              className="rpc-ps-drop-chip"
                              title={d.prevAsk ? `Dropped from ${fmtUsd(d.prevAsk)}` : "Price dropped"}
                            >
                              ▼ {d.askDropPct != null ? `${Math.round(d.askDropPct * 100)}%` : "drop"}
                            </span>
                          ) : null}
                          {mounted && d.askChangedAt ? (
                            <span className="rpc-ps-listed-rel">{relTime(d.askChangedAt)}</span>
                          ) : null}
                          {d.highVariance ? (
                            <span
                              className="rpc-ps-hivar-chip"
                              title={`High variance: ${d.highVarianceReasons
                                .map((r) => VARIANCE_REASON_LABEL[r] ?? r)
                                .join(", ")}`}
                            >
                              HIGH VARIANCE
                            </span>
                          ) : null}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="rpc-ps-td-num">
                    <span className="rpc-ps-tier-chip" style={{ color: tierColor(d.tier) }}>
                      {(d.tier ?? "—").toUpperCase()}
                    </span>
                  </td>
                  <td className="rpc-ps-td-num rpc-ps-td-emph">{fmtUsd(d.lowestAsk)}</td>
                  <td className="rpc-ps-td-num">{fmtUsd(d.grossEV)}</td>
                  <td className={`rpc-ps-td-num rpc-ps-td-emph ${d.highVariance ? "rpc-ps-td-hivar" : ""}`}>
                    {fmtRatio(d.liveValueRatio)}
                  </td>
                  <td className="rpc-ps-td-num">{d.fmvCoveragePct}%</td>
                  <td className="rpc-ps-td-act">
                    <TrackedOutboundLink
                      href={d.buyUrl}
                      payload={{
                        surface: "pack-sniper",
                        destination: "topshot",
                        setName: d.title.trim() || null,
                        tier: d.tier ?? null,
                        askPrice: Number.isFinite(d.lowestAsk) ? d.lowestAsk : null,
                        fmv: Number.isFinite(d.grossEV) ? d.grossEV : null,
                        discount: Number.isFinite(d.discountPct) ? d.discountPct : null,
                        buyUrl: d.buyUrl,
                      }}
                      className="rpc-ps-act rpc-ps-act-buy"
                    >
                      View Listing ↗
                    </TrackedOutboundLink>
                    {d.dapperUrl && d.dapperUrl !== d.buyUrl ? (
                      <TrackedOutboundLink
                        href={d.dapperUrl}
                        payload={{
                          surface: "pack-sniper",
                          destination: "dapper_market_packs",
                          setName: d.title.trim() || null,
                          tier: d.tier ?? null,
                          askPrice: Number.isFinite(d.lowestAsk) ? d.lowestAsk : null,
                          fmv: Number.isFinite(d.grossEV) ? d.grossEV : null,
                          discount: Number.isFinite(d.discountPct) ? d.discountPct : null,
                          buyUrl: d.dapperUrl,
                        }}
                        className="rpc-ps-act"
                      >
                        dapper.market ↗
                      </TrackedOutboundLink>
                    ) : null}
                    <Link href={d.simulatorHref} className="rpc-ps-act">
                      Simulate
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Footer / methodology ──────────────────────────────────────── */}
      <section className="rpc-ps-footer">
        <div className="rpc-ps-method">
          <h3 className="rpc-ps-h3">Methodology — read this</h3>
          <p>
            <strong>Gross EV</strong> is the <em>drop-weighted expectation</em> of a single
            pack&apos;s pull value, summed across the live drop pool using RPC&apos;s FMV.{" "}
            <strong>EV / ask</strong> = gross EV ÷ the live lowest secondary ask. We rank by EV / ask
            — the <em>ordering</em> is the signal, not the number.
          </p>
          <p>
            <strong>&ldquo;Recently listed&rdquo;, NEW and ▼ are snapshot-derived.</strong> Top
            Shot&apos;s pack feed doesn&apos;t expose a per-listing timestamp, so we snapshot the
            live pack book every few minutes and diff it. A pack is flagged <strong>NEW</strong> when
            its lowest ask first appears in our snapshot (within the last 2h) and <strong>▼</strong>{" "}
            when that ask drops. Treat them as &ldquo;changed recently,&rdquo; not a precise on-chain
            clock.
          </p>
          <p>
            <strong>Variance is huge.</strong> EV is an average, not what you should expect to pull.
            A pack with one rare chase can show a high EV while the <em>typical</em> rip returns far
            less. We hide chance-hit / single-chase / heavily-depleted packs by default (toggle
            above) and flag them when shown. The <strong>Simulate</strong> link on every row shows
            the real outcome distribution — use it before buying.
          </p>
          <p>
            Only packs with ≥80% FMV coverage, an EV snapshot from the last 72h, and a live secondary
            listing appear here. EV / ask updates as the EV recomputes and the market moves; a deal
            can close before you click.
          </p>
          <p>
            Want the honest history instead?{" "}
            <Link href="/insights/pack-reality" className="rpc-ps-xlink">
              Pack Reality audits every rip of the last 60 days →
            </Link>
          </p>
        </div>
        <div className="rpc-ps-share">
          <a href={tweetIntent} target="_blank" rel="noopener noreferrer" className="rpc-ps-share-btn">
            Share on Twitter
          </a>
          <Link href="/insights" className="rpc-ps-back">
            More public insights →
          </Link>
        </div>
      </section>
    </main>
  )
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    background: "var(--rpc-black)",
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-body)",
    padding: "32px 20px 80px",
  },
  pageEmbedded: {
    color: "var(--rpc-text-primary)",
    fontFamily: "var(--font-body)",
    padding: "4px 0 40px",
  },
}

const CSS = `
.rpc-ps-hero { max-width: 1180px; margin: 0 auto 28px; padding-bottom: 24px; border-bottom: 1px solid var(--rpc-border-subtle); }
.rpc-ps-hero-compact { margin-bottom: 18px; padding-bottom: 16px; }
.rpc-ps-h1-compact { font-size: clamp(28px, 4vw, 40px); margin-bottom: 10px; }
.rpc-ps-h1-coll { color: var(--rpc-text-muted); font-weight: 700; }
.rpc-ps-eyebrow { font-family: var(--font-mono); font-size: 12px; letter-spacing: 4px; text-transform: uppercase; color: var(--rpc-red); margin-bottom: 12px; }
.rpc-ps-h1 { font-family: var(--font-display); font-weight: 800; font-size: clamp(38px, 6vw, 64px); letter-spacing: 0.5px; line-height: 1.02; margin: 0 0 14px; text-transform: uppercase; }
.rpc-ps-lede { font-family: var(--font-body); font-size: 18px; line-height: 1.55; color: var(--rpc-text-secondary); max-width: 820px; margin: 0 0 16px; }
.rpc-ps-lede strong { color: var(--rpc-text-primary); }
.rpc-ps-lede em { color: var(--rpc-text-primary); font-style: normal; text-decoration: underline; text-decoration-color: var(--rpc-red-muted); text-underline-offset: 3px; }
.rpc-ps-meta-row { font-family: var(--font-mono); font-size: 11px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-meta-sep { margin: 0 8px; color: var(--rpc-text-ghost); }

.rpc-ps-controls { max-width: 1180px; margin: 0 auto 20px; display: flex; flex-wrap: wrap; gap: 14px 20px; align-items: flex-end; }
.rpc-ps-pill-group { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.rpc-ps-pill { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1.5px; text-transform: uppercase; padding: 7px 14px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms, background 120ms; }
.rpc-ps-pill:hover { border-color: var(--rpc-border-hover); color: var(--rpc-text-primary); }
.rpc-ps-pill-active { background: var(--rpc-red-bg); border-color: var(--rpc-red); color: var(--rpc-red); }
.rpc-ps-field { display: inline-flex; flex-direction: column; gap: 5px; }
.rpc-ps-field-label { font-family: var(--font-mono); font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-muted); }
.rpc-ps-select, .rpc-ps-input { font-family: var(--font-mono); font-size: 12px; letter-spacing: 1px; color: var(--rpc-text-primary); background: var(--rpc-surface-raised); border: 1px solid var(--rpc-border); border-radius: 2px; padding: 7px 10px; }
.rpc-ps-select:hover, .rpc-ps-input:hover { border-color: var(--rpc-border-hover); }
.rpc-ps-select:focus, .rpc-ps-input:focus { outline: none; border-color: var(--rpc-red); box-shadow: 0 0 0 2px var(--rpc-red-bg); }
.rpc-ps-input { width: 92px; }
.rpc-ps-toggle { display: inline-flex; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-secondary); cursor: pointer; }
.rpc-ps-toggle input { accent-color: var(--rpc-red); width: 15px; height: 15px; cursor: pointer; }
.rpc-ps-refresh { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; }
.rpc-ps-countdown { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; color: var(--rpc-text-muted); min-width: 56px; text-align: right; }
.rpc-ps-refresh-btn { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; padding: 6px 12px; border: 1px solid var(--rpc-border); background: transparent; color: var(--rpc-text-secondary); cursor: pointer; border-radius: 2px; transition: border-color 120ms, color 120ms; }
.rpc-ps-refresh-btn:hover { border-color: var(--rpc-red); color: var(--rpc-red); }

.rpc-ps-kpi-row { max-width: 1180px; margin: 0 auto 18px; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.rpc-ps-kpi { border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); padding: 14px 16px; border-radius: 2px; }
.rpc-ps-kpi-label { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); margin-bottom: 6px; }
.rpc-ps-kpi-value { font-family: var(--font-display); font-weight: 800; font-size: 30px; color: var(--rpc-red); letter-spacing: 0.5px; }

.rpc-ps-table-wrap { max-width: 1180px; margin: 0 auto; border: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface); overflow-x: auto; border-radius: 2px; }
.rpc-ps-state { padding: 32px; text-align: center; font-family: var(--font-mono); font-size: 13px; letter-spacing: 1.5px; color: var(--rpc-text-muted); line-height: 1.6; }
.rpc-ps-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.rpc-ps-table th { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2.5px; text-transform: uppercase; color: var(--rpc-text-muted); text-align: left; padding: 14px 12px; border-bottom: 1px solid var(--rpc-border-subtle); background: var(--rpc-surface-raised); white-space: nowrap; }
.rpc-ps-th-num { text-align: right; }
.rpc-ps-th-act { text-align: right; }
.rpc-ps-th-emph { color: var(--rpc-red); }
.rpc-ps-row { border-bottom: 1px solid var(--rpc-border-subtle); transition: background 100ms; }
.rpc-ps-row:hover { background: var(--rpc-surface-hover); }
.rpc-ps-table td { padding: 12px; vertical-align: middle; }
.rpc-ps-td-pack { min-width: 280px; }
.rpc-ps-pack-link { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
.rpc-ps-pack-img { width: 44px; height: 44px; object-fit: contain; border-radius: 3px; background: var(--rpc-black); flex-shrink: 0; }
.rpc-ps-pack-img-empty { border: 1px solid var(--rpc-border-subtle); }
.rpc-ps-pack-meta { display: flex; flex-direction: column; gap: 3px; }
.rpc-ps-pack-title { font-family: var(--font-body); font-weight: 700; font-size: 14px; color: var(--rpc-text-primary); line-height: 1.25; }
.rpc-ps-pack-sub { font-family: var(--font-mono); font-size: 10px; letter-spacing: 1px; color: var(--rpc-text-muted); display: inline-flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.rpc-ps-new-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1.5px; color: var(--rpc-success); border: 1px solid var(--rpc-success); padding: 1px 5px; border-radius: 2px; }
.rpc-ps-drop-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1px; color: var(--rpc-warning); border: 1px solid var(--rpc-warning); padding: 1px 5px; border-radius: 2px; }
.rpc-ps-listed-rel { color: var(--rpc-text-ghost); }
.rpc-ps-hivar-chip { font-family: var(--font-mono); font-size: 9px; letter-spacing: 1.5px; color: var(--rpc-red); border: 1px solid var(--rpc-red-border); padding: 1px 5px; border-radius: 2px; }
.rpc-ps-td-num { text-align: right; font-family: var(--font-mono); color: var(--rpc-text-primary); white-space: nowrap; }
.rpc-ps-td-emph { color: var(--rpc-red); font-weight: 700; }
.rpc-ps-td-hivar { color: var(--rpc-text-muted); }
.rpc-ps-tier-chip { font-family: var(--font-mono); font-size: 10px; letter-spacing: 2px; text-transform: uppercase; }
.rpc-ps-td-act { text-align: right; white-space: nowrap; }
.rpc-ps-act { font-family: var(--font-mono); font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; text-decoration: none; color: var(--rpc-text-secondary); padding: 6px 8px; border-radius: 2px; }
.rpc-ps-act:hover { color: var(--rpc-red); }
.rpc-ps-act-buy { color: var(--rpc-red); border: 1px solid var(--rpc-red-border); margin-right: 6px; }
.rpc-ps-act-buy:hover { background: var(--rpc-red); color: #fff; }

.rpc-ps-footer { max-width: 1180px; margin: 36px auto 0; display: grid; grid-template-columns: 2fr 1fr; gap: 32px; }
.rpc-ps-method h3 { font-family: var(--font-display); font-weight: 800; font-size: 22px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 10px; }
.rpc-ps-method p { font-size: 14px; line-height: 1.65; color: var(--rpc-text-secondary); margin: 0 0 12px; }
.rpc-ps-method strong { color: var(--rpc-text-primary); }
.rpc-ps-method em { color: var(--rpc-text-primary); font-style: italic; }
.rpc-ps-xlink { color: var(--rpc-red); text-decoration: none; font-weight: 600; }
.rpc-ps-xlink:hover { text-decoration: underline; }
.rpc-ps-share { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
.rpc-ps-share-btn { display: inline-flex; align-items: center; justify-content: center; background: var(--rpc-red); color: #fff; font-family: var(--font-mono); font-size: 12px; letter-spacing: 2.5px; text-transform: uppercase; padding: 13px 18px; border-radius: 2px; text-decoration: none; transition: background 120ms; }
.rpc-ps-share-btn:hover { background: var(--rpc-red-hover); }
.rpc-ps-back { font-family: var(--font-mono); font-size: 12px; letter-spacing: 2px; text-transform: uppercase; color: var(--rpc-text-secondary); text-decoration: none; padding: 10px; text-align: center; }
.rpc-ps-back:hover { color: var(--rpc-red); }

@media (max-width: 760px) {
  .rpc-ps-kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .rpc-ps-footer { grid-template-columns: 1fr; }
  .rpc-ps-table { font-size: 13px; }
  .rpc-ps-td-pack { min-width: 200px; }
  .rpc-ps-refresh { margin-left: 0; }
}
`
```

**Revert:** `git revert` the commit.

---

## Operator step — wire the snapshot cron (cron-job.org)

After the deploy is READY, add ONE cron-job.org entry (this is what populates `pack_ask_state`; until it runs, the board is value-ordered with no NEW/▼ flags):

- **URL:** `https://www.rippackscity.com/api/cron/snapshot-pack-asks` (use `www` — the apex 308-redirects and drops the body/headers).
- **Method:** POST (GET also works).
- **Schedule:** every 5 minutes (`*/5 * * * *`). Cadence is the freshness lever — 2-3 min for snappier "as they get listed", 5+ for lighter egress (cost-flat).
- **Auth:** Advanced → Headers → `Authorization: Bearer <INGEST_SECRET_TOKEN>` (NOT a `?token=` query param; mirror the existing INGEST crons). Do not echo the token value anywhere.
- Stagger off the `:00/:20/:40` rush minutes if convenient (e.g. `2,7,12,…` style) — not critical at this cadence.

First-run note: on the very first tick **every** currently-listed pack gets `ask_first_seen_at = now`, so the board will briefly show a lot of NEW badges; it settles within the 2h window as subsequent ticks establish the baseline. Expected, self-healing.

Optionally watchlist it after ~24-48h of clean cadence: add `snapshot-pack-asks` to `pipeline_cadence_watchlist` (e.g. `max_silent_minutes 30, severity medium`) so `detect_stalled_pipelines()` catches a dead cron. Don't ship the watchlist row until the cadence is proven (the standard gate).

---

## Insights-QA checklist (this surface)

1. **Backing data** — `pack_table_rows` + live listings unchanged; `pack_ask_state` is the new join (empty until the cron runs → board still serves, recency null). After the cron runs, confirm rows: `SELECT collection_slug, count(*) FILTER (WHERE is_listed) FROM pack_ask_state GROUP BY 1;`
2. **Security** — `pack_ask_state` is a TABLE (not a view): RLS on, anon/auth **SELECT-only**, read server-side via service role. `check_public_security_invariants()` = 0 and `check_secdef_anon_execute_violations()` = `[]` verified at migration time. (No new view → no `security_invoker` concern.)
3. **Route + page + OG** — smoke `/api/public/insights/pack-sniper` (200 JSON), `/insights/pack-sniper` (renders for anon), `/api/og/insights/pack-sniper` (200). All pre-existing; unchanged paths.
4. **Sitemap** — `pack-sniper` already in `app/sitemap.ts` (line ~317). ✓
5. **Canonical** — controls are **client state, not URL params**, so no `?sort=`/`?tier=` duplicate-content surface. Existing `layout.tsx` self-canonical stands. ✓
6. **Drill-downs** — per-row `/<collection>/pack/dist/<distId>` + Simulate links unchanged. ✓
7. **Freshness + honesty** — recency is snapshot-derived; the methodology paragraph says so explicitly; empty state is recency/filter-aware. ✓
8. **Brand** — RPC tokens only: NEW = `var(--rpc-success)`, ▼ = `var(--rpc-warning)`, accents `var(--rpc-red)`, fonts `var(--font-*)`. No hardcoded hex. ✓

---

## Expected end state

- One commit on `main`, Vercel deploy READY, `npx tsc --noEmit` clean.
- `/insights/pack-sniper` + both collection tabs show the new sort/tier/price controls + 30s auto-refresh + pause; rows carry NEW / ▼ badges + "listed Xm ago" once the cron has run.
- `snapshot-pack-asks` logs `ok=true` in `pipeline_runs` every ~5 min; `pack_ask_state` fills (TS ~hundreds of dists, AllDay ~thousands).
- Board defaults to "Recently Listed" — pack deals surface **as they get listed**, with parity to the regular Sniper's controls.

### Full revert (everything)

1. App: `git revert <commit>` (cron route, `pack-deals.ts`, `PackSniperClient.tsx`, page limits, cache header) + redeploy.
2. Cron: delete the cron-job.org `snapshot-pack-asks` entry.
3. DB (only if fully abandoning — otherwise leave inert):
   ```sql
   DROP FUNCTION IF EXISTS public.upsert_pack_ask_state(text, jsonb);
   DROP TABLE IF EXISTS public.pack_ask_state;
   ```
