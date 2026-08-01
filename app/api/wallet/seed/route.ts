import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const maxDuration = 60

const FLOW_REST = "https://rest-mainnet.onflow.org/v1/scripts"

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const GOLAZOS_COLLECTION_ID = "06248cc4-b85f-47cd-af67-1855d14acd75"
const UFC_COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"

type CollectionSpec = {
  slug: string
  collectionId: string
  cadence: string
  editionsTable: "editions" | "pinnacle_editions"
}

const COLLECTIONS: CollectionSpec[] = [
  {
    slug: "nba-top-shot",
    collectionId: TOPSHOT_COLLECTION_ID,
    editionsTable: "editions",
    cadence: `
import TopShot from 0x0b2a3299cc857e29
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim(),
  },
  {
    slug: "nfl-all-day",
    collectionId: ALLDAY_COLLECTION_ID,
    editionsTable: "editions",
    cadence: `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/AllDayNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim(),
  },
  {
    slug: "disney-pinnacle",
    collectionId: PINNACLE_COLLECTION_ID,
    editionsTable: "pinnacle_editions",
    cadence: `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/PinnacleCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim(),
  },
  {
    slug: "laliga-golazos",
    collectionId: GOLAZOS_COLLECTION_ID,
    editionsTable: "editions",
    cadence: `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/GolazoNFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim(),
  },
  {
    slug: "ufc-strike",
    collectionId: UFC_COLLECTION_ID,
    editionsTable: "editions",
    cadence: `
import NonFungibleToken from 0x1d7e57aa55817448
access(all) fun main(address: Address): [UInt64] {
  let acct = getAccount(address)
  let col = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/UFC_NFTCollection)
  if col == nil { return [] }
  return col!.getIDs()
}
`.trim(),
  },
]

async function fetchIds(cadence: string, wallet: string): Promise<string[]> {
  const body = {
    script: btoa(cadence),
    arguments: [btoa(JSON.stringify({ type: "Address", value: wallet }))],
  }
  const res = await fetch(`${FLOW_REST}?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) {
    throw new Error(`Flow script HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const raw = await res.text()
  const decoded = JSON.parse(atob(raw.trim().replace(/^"|"$/g, "")))
  const arr: Array<{ value: string }> = decoded?.value ?? []
  return arr.map((v) => String(v.value))
}

type EditionRow = {
  external_id: string | null
  player_name?: string | null
  character_name?: string | null
  set_name?: string | null
  tier?: string | null
  thumbnail_url?: string | null
  ask_price?: number | null
}

type FmvRow = {
  edition_id: string
  fmv_usd: number | null
  computed_at: string
}

async function enrichStandard(
  ids: string[],
  collectionId: string
): Promise<Map<string, { edition: any; fmv: number | null }>> {
  const out = new Map<string, { edition: any; fmv: number | null }>()
  if (ids.length === 0) return out

  // Chunked at 500 (repo convention). An unchunked .in() over a mega-wallet's
  // id list clamps at PostgREST's 1000-row cap and can blow the URL length
  // cap outright — and supabase-js surfaces that as a NON-THROWING error, so
  // the old `const { data: editions }` (error not destructured) turned a total
  // lookup failure into "zero editions matched". Every moment then missed
  // enrichment and the caller wrote it as a bare row: edition_key NULL,
  // serial NULL, unrecoverable. That is how wallet 0x25ab9f12447a88f4 ended
  // up 5,426/5,477 (99.1%) bare in one 2026-07-28 pass.
  const byExternal = new Map<string, any>()
  const editionIds: string[] = []
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK)
    const { data: editions, error: edErr } = await (supabaseAdmin as any)
      .from("editions")
      .select("id, external_id, player_name, set_name, tier, thumbnail_url")
      .eq("collection_id", collectionId)
      .in("external_id", slice)
    if (edErr) {
      // Surface instead of silently degrading to "no editions matched".
      throw new Error(`enrichStandard editions lookup failed: ${edErr.message}`)
    }
    for (const row of (editions ?? []) as any[]) {
      if (row.external_id) {
        byExternal.set(String(row.external_id), row)
        editionIds.push(row.id)
      }
    }
  }

  // fmv_current (DISTINCT ON latest-per-edition, 1 row/edition), NOT raw
  // fmv_snapshots ordered DESC with a JS latest-wins dedup. The raw pattern
  // overflows PostgREST's 1000-row cap after only a few hundred editions
  // (~35 daily history rows each), silently dropping the tail — the FMV
  // 1000-row-cap class fixed platform-wide on 2026-07-29. Chunked for the
  // same reason as the editions lookup above.
  const fmvByEdition = new Map<string, number | null>()
  for (let i = 0; i < editionIds.length; i += CHUNK) {
    const slice = editionIds.slice(i, i + CHUNK)
    const { data: fmvs, error: fmvErr } = await (supabaseAdmin as any)
      .from("fmv_current")
      .select("edition_id, fmv_usd")
      .in("edition_id", slice)
    if (fmvErr) {
      // Non-fatal: FMV is a display enrichment, and degrading it to null is
      // honest. Identity (edition_key) must NOT depend on it.
      console.warn(`[wallet/seed] fmv_current lookup failed: ${fmvErr.message}`)
      continue
    }
    for (const row of (fmvs ?? []) as FmvRow[]) {
      if (!fmvByEdition.has(row.edition_id)) {
        fmvByEdition.set(row.edition_id, row.fmv_usd)
      }
    }
  }

  for (const id of ids) {
    const edition = byExternal.get(id)
    if (!edition) continue
    out.set(id, { edition, fmv: fmvByEdition.get(edition.id) ?? null })
  }

  return out
}

async function enrichPinnacle(ids: string[]): Promise<Map<string, { edition: any; fmv: number | null }>> {
  const out = new Map<string, { edition: any; fmv: number | null }>()
  if (ids.length === 0) return out

  const { data: editions } = await (supabaseAdmin as any)
    .from("pinnacle_editions")
    .select("id, external_id, character_name, set_name, variant_type, thumbnail_url")
    .in("external_id", ids)

  for (const row of (editions ?? []) as any[]) {
    if (!row.external_id) continue
    out.set(String(row.external_id), {
      edition: row,
      // ASK-unify (2026-07-17): the legacy pinnacle_editions.ask_price is
      // retired — the render-grain pinnacle_catalog.floor_ask is canonical,
      // and this seed-time value was vestigial anyway (keys on external_id,
      // populated on 31/503 rows; overwritten by populate-pinnacle-wmc-fmv).
      fmv: null,
    })
  }

  return out
}

export async function POST(req: NextRequest) {
  const token = req.headers.get("x-ingest-token") ?? ""
  const expected = process.env.INGEST_SECRET_TOKEN ?? ""
  if (!expected || token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { walletAddress?: unknown; ownerKey?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { walletAddress, ownerKey } = body
  if (typeof walletAddress !== "string" || !walletAddress) {
    return NextResponse.json({ error: "walletAddress required" }, { status: 400 })
  }

  const wallet = walletAddress.trim().toLowerCase()
  const results: Array<{ collection: string; count: number; status: string }> = []

  for (const spec of COLLECTIONS) {
    try {
      const ids = await fetchIds(spec.cadence, wallet)

      if (ids.length === 0) {
        results.push({ collection: spec.slug, count: 0, status: "empty" })
        continue
      }

      const enriched =
        spec.slug === "disney-pinnacle"
          ? await enrichPinnacle(ids)
          : await enrichStandard(ids, spec.collectionId)

      const moments = ids.map((id) => {
        const match = enriched.get(id)
        const edition = match?.edition ?? null
        const playerName = edition?.player_name ?? null
        const characterName = spec.slug === "disney-pinnacle" ? edition?.character_name ?? null : null
        const editionName = playerName ?? characterName ?? null
        const tier = edition?.tier ?? edition?.variant_type ?? null
        const fmvUsd = match?.fmv ?? null

        return {
          moment_id: String(id),
          edition_key: edition?.external_id ?? null,
          edition_name: editionName,
          player_name: playerName,
          character_name: characterName,
          set_name: edition?.set_name ?? null,
          tier,
          serial_number: null,
          fmv_usd: fmvUsd,
          image_url: edition?.thumbnail_url ?? null,
          is_locked: false,
          metadata: null,
        }
      })

      const { error } = await (supabaseAdmin as any).rpc("upsert_wallet_moments", {
        p_wallet_address: wallet,
        p_collection_id: spec.collectionId,
        p_moments: moments,
      })

      if (error) {
        results.push({ collection: spec.slug, count: moments.length, status: `rpc_error: ${error.message}` })
      } else {
        results.push({ collection: spec.slug, count: moments.length, status: "ok" })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ collection: spec.slug, count: 0, status: `error: ${msg}` })
    }
  }

  return NextResponse.json({
    ok: true,
    walletAddress: wallet,
    ownerKey: typeof ownerKey === "string" ? ownerKey : null,
    results,
  })
}
