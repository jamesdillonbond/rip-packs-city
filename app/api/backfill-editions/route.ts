import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { topshotGraphql } from "@/lib/topshot"

// Process at most 100 NFTs per run to stay within Vercel's ~25s timeout.
const BATCH_SIZE = 100
// GQL concurrency — keep low to avoid rate limiting.
const CONCURRENCY = 5
// Backfill state key for offset tracking across runs.
const STATE_KEY = "topshot_edition_integer_keys"

// ── GQL moment lookup ──────────────────────────────────────────────────────

type MintedMomentData = {
  getMintedMoment?: {
    data?: {
      set?: { id?: string | null } | null
      play?: { id?: string | null } | null
    } | null
  } | null
}

const GET_MOMENT_QUERY = `
  query GetMomentEdition($id: ID!) {
    getMintedMoment(momentId: $id) {
      data {
        set { id }
        play { id }
      }
    }
  }
`

async function fetchMomentSetPlay(
  nftId: string
): Promise<{ setID: number; playID: number } | null> {
  try {
    const data = await topshotGraphql<MintedMomentData>(GET_MOMENT_QUERY, { id: nftId })
    const moment = data?.getMintedMoment?.data
    if (!moment?.set?.id || !moment?.play?.id) return null

    const setID = parseInt(moment.set.id, 10)
    const playID = parseInt(moment.play.id, 10)
    if (isNaN(setID) || isNaN(playID) || setID <= 0 || playID <= 0) return null

    return { setID, playID }
  } catch (err) {
    console.warn(
      `[backfill-editions] GQL failed for nftId=${nftId}: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`
    )
    return null
  }
}

// ── Concurrency helper ──────────────────────────────────────────────────────

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => runWorker())
  )
  return results
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function POST(req: Request) {
  const startTime = Date.now()

  // Auth — Bearer token
  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let processed = 0
  let upserted = 0
  let updated = 0

  try {
    // ── Step 1: Load backfill offset from backfill_state ──────────────────
    const { data: stateRow } = await supabaseAdmin
      .from("backfill_state")
      .select("*")
      .eq("id", STATE_KEY)
      .single()

    const offset = stateRow?.cursor ? parseInt(stateRow.cursor, 10) : 0

    // ── Step 2: Query moments with UUID-format edition external_ids ───────
    // external_id NOT matching "digits:digits" means it still has UUID keys.
    const { data: rows, error: queryErr } = await supabaseAdmin
      .from("moments")
      .select("nft_id, edition_id, editions!inner(external_id)")
      .not("nft_id", "is", null)
      .order("nft_id", { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1)

    if (queryErr) {
      throw new Error(`Supabase query error: ${queryErr.message}`)
    }

    // Filter to only UUID-format external_ids (not yet integer-keyed)
    const candidates = (rows ?? []).filter((row: any) => {
      const extId = row.editions?.external_id as string | undefined
      return extId && !/^\d+:\d+$/.test(extId)
    })

    if (candidates.length === 0) {
      // Check if we've processed everything
      const totalRows = rows?.length ?? 0
      if (totalRows === 0) {
        // Reset offset — we've covered all moments
        await supabaseAdmin
          .from("backfill_state")
          .upsert({
            id: STATE_KEY,
            cursor: "0",
            status: "complete",
            last_run_at: new Date().toISOString(),
          }, { onConflict: "id" })

        return NextResponse.json({
          ok: true,
          message: "No more UUID-format editions to backfill",
          processed: 0,
          upserted: 0,
          updated: 0,
          offset,
          durationMs: Date.now() - startTime,
        })
      }

      // There were rows but all already have integer keys — advance offset
      await supabaseAdmin
        .from("backfill_state")
        .upsert({
          id: STATE_KEY,
          cursor: String(offset + BATCH_SIZE),
          status: "running",
          last_run_at: new Date().toISOString(),
        }, { onConflict: "id" })

      return NextResponse.json({
        ok: true,
        message: "Batch already had integer keys, advancing offset",
        processed: 0,
        upserted: 0,
        updated: 0,
        offset: offset + BATCH_SIZE,
        durationMs: Date.now() - startTime,
      })
    }

    // ── Step 3: Call GQL for each nft_id with concurrency ────────────────
    const results = await mapWithConcurrency(candidates, CONCURRENCY, async (row: any) => {
      const nftId = String(row.nft_id)
      const editionId = row.edition_id as string
      const meta = await fetchMomentSetPlay(nftId)
      return { nftId, editionId, meta }
    })

    // ── Step 4: Upsert / update for each successful result ────────────────
    for (const { editionId, meta } of results) {
      processed++
      if (!meta) continue

      const externalId = `${meta.setID}:${meta.playID}`

      // Upsert an edition row with the integer external_id
      const { error: upsertErr } = await supabaseAdmin
        .from("editions")
        .upsert(
          [{ external_id: externalId }],
          { onConflict: "external_id,collection_id", ignoreDuplicates: true }
        )

      if (!upsertErr) upserted++

      // Update the existing edition record with on-chain integer IDs
      const { error: updateErr } = await supabaseAdmin
        .from("editions")
        .update({ set_id_onchain: meta.setID, play_id_onchain: meta.playID })
        .eq("id", editionId)
        .is("set_id_onchain", null)

      if (!updateErr) updated++
    }

    // ── Step 5: Persist offset in backfill_state ──────────────────────────
    await supabaseAdmin
      .from("backfill_state")
      .upsert({
        id: STATE_KEY,
        cursor: String(offset + BATCH_SIZE),
        status: "running",
        total_ingested: (stateRow?.total_ingested ?? 0) + processed,
        last_run_at: new Date().toISOString(),
      }, { onConflict: "id" })

    const durationMs = Date.now() - startTime
    console.log(
      `[backfill-editions] Done — processed=${processed}, upserted=${upserted}, ` +
      `updated=${updated}, offset=${offset}, durationMs=${durationMs}`
    )

    return NextResponse.json({
      ok: true,
      processed,
      upserted,
      updated,
      offset: offset + BATCH_SIZE,
      durationMs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[backfill-editions] Fatal error:", message)
    return NextResponse.json(
      { ok: false, error: message, processed, upserted, updated, durationMs: Date.now() - startTime },
      { status: 500 }
    )
  }
}
