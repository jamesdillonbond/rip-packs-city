import { NextRequest, NextResponse } from "next/server"
import { topshotGraphql } from "@/lib/topshot"
import { supabaseAdmin } from "@/lib/supabase"

// Untagged Top Shot marketplace-edition sweep that caches each edition's top
// standing offer + lowest ask into edition_offers, keyed on the canonical
// integer pair "setID:playID" (== editions.external_id). Unlike /api/badge-sync
// (which only walks badge-tag-gated plays, ~2,087 editions), this walks the
// FULL marketplace via searchMarketplaceEditions with empty filters, so it
// covers every edition Top Shot publishes an offer/ask for (~16K). It's the
// data substance behind the "best offer" display on the collection grid,
// moment, and edition pages (Item 2, audit 2026-05-31).
//
// The sweep is cursored across cron ticks via pipeline_runs.cursor_after: each
// tick walks MAX_PAGES_PER_TICK pages from the prior cursor and persists the
// next one; reaching the end logs cursor_after=null so the next tick restarts
// at the head (a fresh full refresh cycle). Sorting EDITION_CREATED_AT_DESC,
// newest first.
//
// Operator: add a cron-job.org entry hitting POST /api/cron/offers-sweep with
// Authorization: Bearer $INGEST_SECRET_TOKEN (or ?token=) every ~20 min. A full
// refresh cycle is ~4 ticks. Until the cron is added, the readers fall back to
// badge_editions exactly as before.

export const maxDuration = 300
export const dynamic = "force-dynamic"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PAGE_LIMIT = 100
const MAX_PAGES_PER_TICK = 40
const PAGE_DELAY_MS = 200
const UPSERT_BATCH = 500

const QUERY = `
  query OffersSweep($searchInput: BaseSearchInput!) {
    searchMarketplaceEditions(input: {
      filters: {}
      sortBy: EDITION_CREATED_AT_DESC
      searchInput: $searchInput
    }) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            size
            data {
              ... on MarketplaceEdition {
                id
                set { id flowId }
                play { id flowID }
                lowAsk
                highestOffer
              }
            }
          }
        }
      }
    }
  }
`

type RawEdition = {
  id: string
  set: { id: string; flowId: string | number | null } | null
  play: { id: string; flowID: string | number | null } | null
  lowAsk: number | null
  highestOffer: number | null
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function intLike(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  // "0" is Top Shot's "unset" sentinel for flowId here, not a real on-chain id.
  if (!/^\d+$/.test(s) || s === "0") return null
  return s
}

// Canonical edition key = setID_onchain:playID_onchain (== editions.external_id).
// set.flowId is unreliable (0 sentinel for many classics), so prefer the
// authoritative sets-table set_id_onchain map keyed by the GQL set UUID;
// fall back to flowId / an already-integer id. A row that can't form an
// integer pair is skipped (a UUID-keyed offer row can never join editions).
function editionKey(e: RawEdition, setMap: Map<string, string>): string | null {
  const playStr = intLike(e.play?.flowID) ?? intLike(e.play?.id)
  let setStr: string | null = e.set?.id ? (setMap.get(e.set.id) ?? null) : null
  if (!setStr) setStr = intLike(e.set?.flowId) ?? intLike(e.set?.id)
  if (!setStr || !playStr) return null
  return `${setStr}:${playStr}`
}

async function fetchSetOnchainMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const { data, error } = await (supabaseAdmin as any)
    .from("sets")
    .select("external_id, set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .not("set_id_onchain", "is", null)
    .limit(10000)
  if (error) {
    console.log("[offers-sweep] set onchain map error:", error.message)
    return map
  }
  for (const r of (data as Array<{ external_id: string | null; set_id_onchain: number | null }> | null) ?? []) {
    if (r.external_id && r.set_id_onchain != null) map.set(r.external_id, String(r.set_id_onchain))
  }
  return map
}

async function fetchPage(
  cursor: string
): Promise<{ editions: RawEdition[]; nextCursor: string | null }> {
  type GqlShape = {
    searchMarketplaceEditions: {
      data: {
        searchSummary: {
          pagination: { rightCursor: string | null }
          data: { size: number; data: RawEdition[] }
        }
      }
    }
  }
  const data = await topshotGraphql<GqlShape>(QUERY, {
    searchInput: { pagination: { direction: "RIGHT", limit: PAGE_LIMIT, cursor } },
  })
  const summary = data?.searchMarketplaceEditions?.data?.searchSummary
  return {
    editions: summary?.data?.data ?? [],
    nextCursor: summary?.pagination?.rightCursor ?? null,
  }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const queryToken = req.nextUrl.searchParams.get("token") ?? ""
  const ok =
    !!process.env.INGEST_SECRET_TOKEN &&
    (bearer === process.env.INGEST_SECRET_TOKEN || queryToken === process.env.INGEST_SECRET_TOKEN)
  if (!ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startTime = Date.now()

  // Resume from the previous run's opaque GQL cursor (null/empty -> head).
  let startCursor = ""
  try {
    const { data: cursorRow } = await (supabaseAdmin as any)
      .from("pipeline_runs")
      .select("cursor_after")
      .eq("pipeline", "offers-sweep")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    const prev = cursorRow?.cursor_after
    if (typeof prev === "string" && prev.length > 0) startCursor = prev
  } catch (err) {
    console.warn("[offers-sweep] cursor read failed, starting at head:", err)
  }

  const setMap = await fetchSetOnchainMap()

  // key -> { offer, ask } across the tick. Multiple parallels collapse to the
  // integer pair; keep the best (max) offer and the lowest (min) ask.
  const acc = new Map<string, { offer: number | null; ask: number | null }>()
  let skippedNoKey = 0
  let cursor = startCursor
  const seen = new Set<string>()
  let pages = 0
  let wrapped = false
  let fetchError: string | null = null

  try {
    while (pages < MAX_PAGES_PER_TICK) {
      if (cursor && seen.has(cursor)) { wrapped = true; break }
      if (cursor) seen.add(cursor)

      const { editions, nextCursor } = await fetchPage(cursor)
      pages++

      for (const e of editions) {
        const key = editionKey(e, setMap)
        if (!key) { skippedNoKey++; continue }
        const offer = typeof e.highestOffer === "number" && e.highestOffer > 0 ? e.highestOffer : null
        const ask = typeof e.lowAsk === "number" && e.lowAsk > 0 ? e.lowAsk : null
        const prev = acc.get(key)
        if (!prev) {
          acc.set(key, { offer, ask })
        } else {
          acc.set(key, {
            offer: offer != null ? Math.max(prev.offer ?? 0, offer) : prev.offer,
            ask: ask != null ? Math.min(prev.ask ?? Infinity, ask) : prev.ask,
          })
        }
      }

      // End of the catalog: short page or no/repeat cursor -> wrap to head.
      if (!nextCursor || editions.length < PAGE_LIMIT || nextCursor === cursor) {
        wrapped = true
        cursor = ""
        break
      }
      cursor = nextCursor
      await sleep(PAGE_DELAY_MS)
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
    console.log("[offers-sweep] fetch error:", fetchError)
  }

  // Upsert only rows that carry at least one of offer/ask (a row with both null
  // tells the reader nothing the absence of a row wouldn't).
  const rows = Array.from(acc.entries())
    .filter(([, v]) => v.offer != null || v.ask != null)
    .map(([external_id, v]) => ({
      collection_id: COLLECTION_ID,
      external_id,
      highest_offer: v.offer,
      low_ask: v.ask,
      updated_at: new Date().toISOString(),
    }))

  let upserted = 0
  let upsertErrors = 0
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH)
    const { error } = await (supabaseAdmin as any)
      .from("edition_offers")
      .upsert(batch, { onConflict: "collection_id,external_id" })
    if (error) {
      console.log(`[offers-sweep] upsert batch ${i} error:`, error.message)
      upsertErrors++
    } else {
      upserted += batch.length
    }
  }

  const nextCursorToLog = wrapped ? null : cursor

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: "offers-sweep",
      p_started_at: new Date(startTime).toISOString(),
      p_rows_found: acc.size,
      p_rows_written: upserted,
      p_rows_skipped: skippedNoKey,
      p_ok: fetchError === null,
      p_error: fetchError,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: startCursor || null,
      p_cursor_after: nextCursorToLog,
      p_extra: {
        pages,
        wrapped,
        upsert_errors: upsertErrors,
        duration_ms: Date.now() - startTime,
      },
    })
  } catch (err) {
    console.warn("[offers-sweep] log_pipeline_run failed (non-fatal):", err)
  }

  return NextResponse.json({
    ok: fetchError === null,
    pages,
    keyed: acc.size,
    upserted,
    upsertErrors,
    skippedNoKey,
    wrapped,
    error: fetchError,
    durationMs: Date.now() - startTime,
  })
}

export async function GET() {
  const { data, error } = await (supabaseAdmin as any)
    .from("edition_offers")
    .select("collection_id", { count: "exact", head: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, note: "POST with Bearer INGEST_SECRET_TOKEN to run the sweep", data })
}
