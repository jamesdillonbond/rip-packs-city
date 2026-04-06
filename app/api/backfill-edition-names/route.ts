import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

/**
 * POST /api/backfill-edition-names
 *
 * Backfills stub editions (external_id "setId:playId", name IS NULL) using
 * Flowty API listings. Fetches 20 pages (480 listings), extracts metadata
 * from traits, then updates matching edition rows.
 * Auth: Bearer INGEST_SECRET_TOKEN. Processes up to 500 stubs per run.
 */

export const maxDuration = 60

const FLOWTY_ENDPOINT = "https://api2.flowty.io/collection/0x0b2a3299cc857e29/TopShot"
const FLOWTY_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Origin": "https://www.flowty.io",
  "Referer": "https://www.flowty.io/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36",
}

// ── Trait helpers (same as wallet-enrich-flowty) ────────────────────────────

function flattenTraits(raw: unknown): Array<{ name: string; value: string }> {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const inner = (raw as Record<string, unknown>).traits ?? raw
  if (Array.isArray(inner)) return inner
  return Object.values(inner as Record<string, unknown>)
    .filter((v): v is { name: string; value: string } =>
      typeof v === "object" && v !== null && "name" in v)
}

function getTrait(traits: Array<{ name: string; value: string }>, keys: string[]): string {
  for (const key of keys) {
    const found = traits.find(function (t) { return t.name === key })
    if (found?.value) return found.value
  }
  return ""
}

function parseSeriesName(raw: string): number | null {
  if (!raw) return null
  const lower = raw.toLowerCase().trim()
  if (lower === "beta") return 0
  const m = lower.match(/series\s*(\d+)/i)
  if (m) return Number(m[1])
  const n = Number(raw)
  return isNaN(n) ? null : n
}

type FlowtyEditionMeta = {
  playerName: string
  setName: string
  tier: string | null
  series: number | null
}

// ── Fetch one page of Flowty listings ───────────────────────────────────────

async function fetchFlowtyPage(from: number): Promise<Map<string, FlowtyEditionMeta>> {
  const map = new Map<string, FlowtyEditionMeta>()
  try {
    const controller = new AbortController()
    const timeout = setTimeout(function () { controller.abort() }, 10000)
    const res = await fetch(FLOWTY_ENDPOINT, {
      method: "POST",
      headers: FLOWTY_HEADERS,
      body: JSON.stringify({
        address: null, addresses: [],
        collectionFilters: [{ collection: "0x0b2a3299cc857e29.TopShot", traits: [] }],
        from, includeAllListings: true, limit: 24, onlyUnlisted: false,
        orderFilters: [{ conditions: [], kind: "storefront", paymentTokens: [] }],
        sort: { direction: "desc", listingKind: "storefront", path: "blockTimestamp" },
      }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
    if (!res.ok) return map
    const json = await res.json()
    const rawItems: any[] = json?.nfts ?? json?.data ?? []

    for (const item of rawItems) {
      const traits = flattenTraits(item.nftView?.traits)

      // Extract SetID and PlayID from traits
      let setID = ""
      let playID = ""
      if (item.nftView?.setID) setID = String(item.nftView.setID)
      if (item.nftView?.playID) playID = String(item.nftView.playID)
      if (!setID) setID = getTrait(traits, ["SetID", "setID", "setId", "Set ID"])
      if (!playID) playID = getTrait(traits, ["PlayID", "playID", "playId", "Play ID"])
      if (!setID || !playID) continue

      const editionKey = setID + ":" + playID
      if (map.has(editionKey)) continue // first seen is enough

      const playerName = item.card?.title ?? getTrait(traits, ["FullName", "fullName", "Full Name", "PlayerName", "playerName"])
      const setName = getTrait(traits, ["SetName", "setName", "Set Name", "set_name"])
      const seriesRaw = getTrait(traits, ["SeriesName", "seriesName", "Series Name", "SeriesNumber", "seriesNumber", "Series"])
      const tierRaw = getTrait(traits, ["Tier", "tier", "MomentTier", "momentTier"])

      if (!playerName) continue

      map.set(editionKey, {
        playerName,
        setName: setName || "Unknown Set",
        tier: tierRaw ? tierRaw.toUpperCase().replace(/^MOMENT_TIER_/, "") : null,
        series: parseSeriesName(seriesRaw),
      })
    }
    return map
  } catch {
    return map
  }
}

// ── Main route handler ──────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization")
  if (auth !== "Bearer " + process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  // Step 1: Fetch stub editions from Supabase
  const { data: stubs, error: queryErr } = await (supabaseAdmin as any)
    .from("editions")
    .select("id, external_id")
    .is("name", null)
    .like("external_id", "%:%")
    .limit(500)

  if (queryErr) {
    return NextResponse.json({ error: "query error: " + queryErr.message }, { status: 500 })
  }

  const editionsToFill = (stubs ?? []).filter(function (e: any) {
    return /^\d+:\d+$/.test(e.external_id)
  })

  if (editionsToFill.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, unmatched: 0, remaining: 0, flowty_editions: 0 })
  }

  // Step 2: Fetch 20 pages of Flowty listings in parallel
  const offsets = Array.from({ length: 20 }, function (_, i) { return i * 24 })
  const pages = await Promise.all(offsets.map(fetchFlowtyPage))

  // Merge all pages into one map (first page wins on duplicates)
  const flowtyMap = new Map<string, FlowtyEditionMeta>()
  for (const page of pages) {
    for (const [key, meta] of page) {
      if (!flowtyMap.has(key)) flowtyMap.set(key, meta)
    }
  }
  console.log("[backfill-edition-names] flowty map: " + flowtyMap.size + " unique editions from 20 pages")

  // Step 3: Match stubs to Flowty data and update
  let updated = 0
  let unmatched = 0
  const unmatchedSample: string[] = []
  const CHUNK = 50

  for (let i = 0; i < editionsToFill.length; i += CHUNK) {
    const chunk = editionsToFill.slice(i, i + CHUNK)
    for (const stub of chunk) {
      const meta = flowtyMap.get(stub.external_id)
      if (!meta) {
        unmatched++
        if (unmatchedSample.length < 10) unmatchedSample.push(stub.external_id)
        continue
      }

      const { error: upErr } = await (supabaseAdmin as any)
        .from("editions")
        .update({
          name: meta.playerName + " — " + meta.setName,
          tier: meta.tier,
          series: meta.series,
        })
        .eq("id", stub.id)

      if (upErr) {
        console.log("[backfill-edition-names] update error " + stub.external_id + ": " + upErr.message)
      } else {
        updated++
      }
    }
  }

  // Step 4: Count remaining stubs
  const { count: remaining } = await (supabaseAdmin as any)
    .from("editions")
    .select("id", { count: "exact", head: true })
    .is("name", null)
    .like("external_id", "%:%")

  return NextResponse.json({
    ok: true,
    stubs_found: editionsToFill.length,
    flowty_editions: flowtyMap.size,
    updated,
    unmatched,
    unmatched_sample: unmatchedSample,
    remaining: remaining ?? 0,
  })
}
