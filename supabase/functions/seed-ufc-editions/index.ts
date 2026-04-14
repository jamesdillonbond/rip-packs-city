// supabase/functions/seed-ufc-editions/index.ts
//
// Supabase Edge Function: crawls Flowty to discover and seed UFC Strike editions.
//
// POST with ?token=<INGEST_SECRET_TOKEN>
// Paginates through Flowty (api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT),
// groups NFTs by (edition_name, circulation), infers tier from circulation,
// and upserts into public.editions.
//
// Deploy: supabase functions deploy seed-ufc-editions --no-verify-jwt

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const FLOWTY_URL = "https://api2.flowty.io/collection/0x329feb3ab062d289/UFC_NFT"
const PAGE_SIZE = 24
const MAX_PAGES = 500
const INTER_PAGE_DELAY_MS = 500

interface FlowtyTrait { name?: string; value?: unknown }
interface FlowtyCardImage { url?: string }
interface FlowtyEditionInfo { name?: string; number?: number | null; max?: number | null }

interface FlowtyNft {
  id?: string | number
  card?: {
    title?: string
    max?: string | number | null
    num?: string | number | null
    images?: FlowtyCardImage[]
  }
  nftView?: {
    serial?: string | number
    editions?: { infoList?: FlowtyEditionInfo[] }
    traits?: { traits?: FlowtyTrait[] }
  }
}

interface FlowtyResponse {
  nfts?: FlowtyNft[]
  total?: number
}

function inferTier(circulation: number | null): string {
  if (circulation === null) return "FANDOM"
  if (circulation <= 10) return "ULTIMATE"
  if (circulation <= 99) return "CHAMPION"
  if (circulation <= 999) return "CHALLENGER"
  if (circulation <= 25000) return "CONTENDER"
  return "FANDOM"
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ")
    .trim()
}

function slugify(name: string, max: number | null): string {
  const clean = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return max !== null ? `${clean}-${max}` : clean
}

function traitValue(traits: FlowtyTrait[] | undefined, name: string): string | null {
  if (!traits) return null
  const hit = traits.find((t) => t?.name === name)
  if (!hit || hit.value === null || hit.value === undefined) return null
  return String(hit.value)
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchPage(offset: number): Promise<FlowtyResponse | null> {
  try {
    const res = await fetch(FLOWTY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://www.flowty.io",
      },
      body: JSON.stringify({ filters: {}, offset, limit: PAGE_SIZE }),
    })
    if (!res.ok) {
      console.log(`[seed-ufc-editions] flowty HTTP ${res.status} at offset=${offset}`)
      return null
    }
    return await res.json() as FlowtyResponse
  } catch (err) {
    console.log(`[seed-ufc-editions] flowty fetch error offset=${offset}: ${String(err)}`)
    return null
  }
}

interface AggregatedEdition {
  edition_name: string
  circulation: number | null
  fighter_name: string | null
  tier: string
  thumbnail_url: string | null
  external_id: string
}

serve(async (req: Request) => {
  const startedAt = Date.now()

  const url = new URL(req.url)
  const urlToken = url.searchParams.get("token") ?? ""
  const authHeader = req.headers.get("authorization") ?? ""
  const bearer = authHeader.replace(/^Bearer\s+/i, "")
  const expected = Deno.env.get("INGEST_SECRET_TOKEN") ?? ""

  if (!expected || (urlToken !== expected && bearer !== expected)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? ""
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Missing Supabase env" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  const supabase = createClient(supabaseUrl, serviceKey)

  const editionMap = new Map<string, AggregatedEdition>()
  let nftsScanned = 0
  let pagesFetched = 0
  const errors: string[] = []

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE
    const res = await fetchPage(offset)
    if (!res) {
      errors.push(`page offset=${offset} failed`)
      break
    }
    pagesFetched++
    const nfts = Array.isArray(res.nfts) ? res.nfts : []
    if (nfts.length === 0) break

    for (const nft of nfts) {
      nftsScanned++

      const cardTitle = typeof nft.card?.title === "string" ? nft.card.title : null
      const editionInfo = nft.nftView?.editions?.infoList?.[0]
      const editionName = (editionInfo?.name ?? cardTitle ?? "").trim()
      if (!editionName) continue

      const circulation =
        toNum(editionInfo?.max) ??
        toNum(nft.card?.max) ??
        null

      const traits = nft.nftView?.traits?.traits
      const fighterName = traitValue(traits, "ATHLETE 1")

      const thumbnail = nft.card?.images?.[0]?.url ?? null

      const external_id = slugify(editionName, circulation)
      const tier = inferTier(circulation)

      const existing = editionMap.get(external_id)
      if (!existing) {
        editionMap.set(external_id, {
          edition_name: editionName,
          circulation,
          fighter_name: fighterName,
          tier,
          thumbnail_url: thumbnail,
          external_id,
        })
      } else if (!existing.thumbnail_url && thumbnail) {
        existing.thumbnail_url = thumbnail
      }
    }

    if (nfts.length < PAGE_SIZE) break
    if (typeof res.total === "number" && offset + PAGE_SIZE >= res.total) break
    await delay(INTER_PAGE_DELAY_MS)
  }

  const editionsFound = editionMap.size
  let editionsInserted = 0

  const rows = Array.from(editionMap.values()).map((e) => ({
    external_id: e.external_id,
    collection_id: UFC_COLLECTION_ID,
    name: titleCase(e.edition_name),
    player_name: e.fighter_name,
    tier: e.tier,
    circulation_count: e.circulation,
    thumbnail_url: e.thumbnail_url,
  }))

  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK)
    const { error, count } = await supabase
      .from("editions")
      .upsert(batch, { onConflict: "collection_id,external_id", count: "exact" })
    if (error) {
      errors.push(`upsert batch ${i}: ${error.message}`)
    } else {
      editionsInserted += count ?? batch.length
    }
  }

  const body = {
    ok: true,
    editions_found: editionsFound,
    editions_inserted: editionsInserted,
    nfts_scanned: nftsScanned,
    pages_fetched: pagesFetched,
    errors,
    elapsed_ms: Date.now() - startedAt,
  }

  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  })
})
