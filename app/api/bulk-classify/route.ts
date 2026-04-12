import { NextRequest } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// GET /api/bulk-classify?wallet=0x...&token=...&offset=0
//
// Classifies unclassified (acquisition_method='unknown') moments by pulling
// lastPurchasePrice + createdAt from Top Shot GQL. Streams progress as SSE.
// Processes up to ~55 seconds worth of work per call (Hobby plan = 60s limit).
// Caller loops with nextOffset until done.

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN
const TS_GQL =
  process.env.TS_PROXY_URL || "https://public-api.nbatopshot.com/graphql"
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET || ""

const GET_MINTED_MOMENT = `
  query GetMintedMoment($momentId: ID!) {
    getMintedMoment(momentId: $momentId) {
      data {
        flowId
        lastPurchasePrice
        createdAt
      }
    }
  }
`

interface GqlResult {
  flowId: string
  lastPurchasePrice: number | null
  createdAt: string | null
}

async function fetchMoment(momentId: string): Promise<GqlResult | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (TS_PROXY_SECRET) headers["x-proxy-secret"] = TS_PROXY_SECRET

  const res = await fetch(TS_GQL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: GET_MINTED_MOMENT,
      variables: { momentId },
    }),
    signal: AbortSignal.timeout(6000),
  })

  if (!res.ok) return null
  const json = await res.json()
  const d = json?.data?.getMintedMoment?.data
  if (!d) return null

  return {
    flowId: d.flowId ?? momentId,
    lastPurchasePrice:
      d.lastPurchasePrice != null ? Number(d.lastPurchasePrice) : null,
    createdAt: d.createdAt ?? null,
  }
}

async function getAllUnclassifiedIds(
  wallet: string
): Promise<string[]> {
  const all: string[] = []
  let offset = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await (supabaseAdmin as any)
      .from("moment_acquisitions")
      .select("nft_id")
      .eq("wallet", wallet)
      .eq("acquisition_method", "unknown")
      .range(offset, offset + PAGE - 1)

    if (error) throw new Error("Supabase query failed: " + error.message)
    if (!data || data.length === 0) break
    for (const row of data) all.push(row.nft_id)
    if (data.length < PAGE) break
    offset += PAGE
  }
  return all
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl
  const token = url.searchParams.get("token")
  if (!INGEST_TOKEN || token !== INGEST_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  }

  const rawWallet = (url.searchParams.get("wallet") ?? "").trim()
  const hex = rawWallet.replace(/^0x/, "")
  if (!/^[a-fA-F0-9]{16}$/.test(hex)) {
    return new Response(
      JSON.stringify({ error: "wallet required (16-char hex)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    )
  }
  const wallet = "0x" + hex
  const requestedOffset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10) || 0
  )

  // Streaming response via TransformStream
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const send = async (obj: Record<string, unknown>) => {
    await writer.write(encoder.encode(JSON.stringify(obj) + "\n"))
  }

  // Process in background — return the readable stream immediately
  ;(async () => {
    const startTime = Date.now()
    const TIME_LIMIT = 55_000 // 55s safety margin

    try {
      // Fetch all unclassified IDs
      const allIds = await getAllUnclassifiedIds(wallet)
      const total = allIds.length

      await send({ status: "started", total, offset: requestedOffset })

      if (requestedOffset >= total) {
        await send({
          status: "done",
          total,
          processed: 0,
          marketplace: 0,
          datesFilled: 0,
          timeouts: 0,
          errors: 0,
          nextOffset: null,
          remaining: 0,
        })
        await writer.close()
        return
      }

      const ids = allIds.slice(requestedOffset)

      let processed = 0
      let marketplace = 0
      let datesFilled = 0
      let timeouts = 0
      let errors = 0

      // Accumulate updates and flush in batches of 50
      const acquisitionUpdates: Array<{
        nftId: string
        method: string
        buyPrice: number | null
        acquiredDate: string | null
      }> = []
      const dateOnlyUpdates: Array<{
        nftId: string
        acquiredDate: string
      }> = []

      const flushUpdates = async () => {
        // Flush acquisition method updates
        if (acquisitionUpdates.length > 0) {
          const batch = acquisitionUpdates.splice(0, 50)
          await Promise.all(
            batch.map((u) =>
              (supabaseAdmin as any)
                .from("moment_acquisitions")
                .update({
                  acquisition_method: u.method,
                  buy_price: u.buyPrice,
                  acquired_date: u.acquiredDate,
                  source: "bulk_classify",
                })
                .eq("nft_id", u.nftId)
                .eq("wallet", wallet)
                .eq("acquisition_method", "unknown")
            )
          )
        }

        // Flush date-only updates (for moments that remain unknown but got a date)
        if (dateOnlyUpdates.length > 0) {
          const batch = dateOnlyUpdates.splice(0, 50)
          await Promise.all(
            batch.map((u) =>
              Promise.all([
                (supabaseAdmin as any)
                  .from("moment_acquisitions")
                  .update({ acquired_date: u.acquiredDate })
                  .eq("nft_id", u.nftId)
                  .eq("wallet", wallet)
                  .is("acquired_date", null),
                (supabaseAdmin as any)
                  .from("wallet_moments_cache")
                  .update({ acquired_at: u.acquiredDate })
                  .eq("moment_id", u.nftId)
                  .eq("wallet_address", wallet)
                  .is("acquired_at", null),
              ])
            )
          )
        }
      }

      const BATCH_SIZE = 20

      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        // Time check
        if (Date.now() - startTime > TIME_LIMIT) {
          // Flush remaining
          while (acquisitionUpdates.length > 0 || dateOnlyUpdates.length > 0) {
            await flushUpdates()
          }
          const nextOffset = requestedOffset + processed
          await send({
            status: "timeout",
            total,
            processed,
            marketplace,
            datesFilled,
            timeouts,
            errors,
            nextOffset,
            remaining: total - nextOffset,
          })
          await writer.close()
          return
        }

        const batch = ids.slice(i, i + BATCH_SIZE)
        const results = await Promise.allSettled(
          batch.map((id) =>
            fetchMoment(id).catch((err) => {
              if (
                err instanceof Error &&
                (err.name === "AbortError" || err.name === "TimeoutError")
              ) {
                return "TIMEOUT" as const
              }
              throw err
            })
          )
        )

        for (let j = 0; j < batch.length; j++) {
          const momentId = batch[j]
          const result = results[j]
          processed++

          if (result.status !== "fulfilled") {
            errors++
            continue
          }

          const data = result.value
          if (data === "TIMEOUT") {
            timeouts++
            continue
          }
          if (!data) {
            errors++
            continue
          }

          // Classify marketplace purchases
          if (
            data.lastPurchasePrice != null &&
            data.lastPurchasePrice > 0
          ) {
            marketplace++
            acquisitionUpdates.push({
              nftId: momentId,
              method: "marketplace",
              buyPrice: data.lastPurchasePrice,
              acquiredDate: data.createdAt,
            })
          }

          // Fill missing dates for all moments
          if (data.createdAt) {
            datesFilled++
            dateOnlyUpdates.push({
              nftId: momentId,
              acquiredDate: data.createdAt,
            })
          }
        }

        // Flush DB writes when buffers are full
        while (acquisitionUpdates.length >= 50) await flushUpdates()
        while (dateOnlyUpdates.length >= 50) await flushUpdates()

        // Progress update every 100 moments
        if (processed % 100 < BATCH_SIZE) {
          await send({
            status: "progress",
            processed,
            total,
            marketplace,
            datesFilled,
            timeouts,
            errors,
          })
        }

        // Brief pause between GQL batches
        await new Promise((r) => setTimeout(r, 100))
      }

      // Flush any remaining
      while (acquisitionUpdates.length > 0 || dateOnlyUpdates.length > 0) {
        await flushUpdates()
      }

      await send({
        status: "done",
        total,
        processed,
        marketplace,
        datesFilled,
        timeouts,
        errors,
        nextOffset: null,
        remaining: 0,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await send({ status: "error", error: msg })
    } finally {
      await writer.close()
    }
  })()

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  })
}
