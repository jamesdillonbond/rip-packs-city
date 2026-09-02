import { NextRequest, NextResponse, after } from "next/server"

export const maxDuration = 60

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const SUPABASE_FN_BASE = "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1"

type EnrichResponse = {
  done?: boolean
  enriched?: number
  totalEnriched?: number
  total?: number
  next?: number
  nextStart?: number | null
  [key: string]: unknown
}

type ScanResponse = {
  scanned?: number
  total?: number
  [key: string]: unknown
}

// 🚨 THE TOKEN GOES IN A HEADER, NOT THE URL. Supabase edge-function logs record
// full request URLs, so `&token=` wrote INGEST_SECRET_TOKEN — a secret shared
// across ~15 edge functions — into the log store on every UFC wallet scan, which
// is a USER-TRIGGERED path (CollectionTabClient), not a cron.
// ⛔ Do NOT "confirm" the old leak by reading those logs: reading them IS the
// leak. The caller's source is the proof, and it is these two functions.
// ⚠ The token should still be treated as EXPOSED. Stopping new writes does not
// un-write the old ones; rotation is its own project (~15 functions).
async function callScan(wallet: string): Promise<ScanResponse> {
  // Deployed scan-ufc-wallet v40 accepts EITHER a Bearer header or `?token=`
  // (verified against the deployed source, not just repo HEAD), so this is safe.
  const url = `${SUPABASE_FN_BASE}/scan-ufc-wallet?wallet=${encodeURIComponent(wallet)}`
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`scan-ufc-wallet HTTP ${res.status}`)
  return (await res.json()) as ScanResponse
}

async function callEnrich(wallet: string, start: number): Promise<EnrichResponse> {
  // ⛔ STILL `?token=`, AND THAT IS DELIBERATE — DO NOT "FIX" THIS LINE ALONE.
  // Deployed enrich-ufc-wallet v47 reads the Authorization header NOWHERE; the
  // query param is its ONLY accepted path (verified against the deployed source).
  // Moving this to a header before that build ships would 401 every UFC wallet
  // scan — a live user-facing break. The header-accepting build IS written and
  // committed (supabase/functions/enrich-ufc-wallet/index.ts, additive: it keeps
  // `?token=`), and is registered in scripts/check-edge-fn-drift.mjs →
  // DEPLOY_DEFERRED with the reason it was not shipped from here.
  // ORDER, and it only breaks in one direction: deploy that build FIRST, then
  // change this line, then delete the fn's `?token=` branch. Never the reverse.
  // Tracked by __tests__/no-env-secret-in-fetch-url.test.ts, which allows exactly
  // this one site and FAILS if the allowance outlives the leak.
  const url = `${SUPABASE_FN_BASE}/enrich-ufc-wallet?wallet=${encodeURIComponent(wallet)}&token=${TOKEN}&start=${start}`
  const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(55000) })
  if (!res.ok) throw new Error(`enrich-ufc-wallet HTTP ${res.status}`)
  return (await res.json()) as EnrichResponse
}

function pickNumber(...vals: Array<unknown>): number {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v
  }
  return 0
}

export async function POST(req: NextRequest) {
  let body: { wallet?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const wallet = (body.wallet ?? "").trim().toLowerCase()
  if (!wallet.startsWith("0x")) {
    return NextResponse.json({ error: "Wallet must start with 0x" }, { status: 400 })
  }
  if (!TOKEN) {
    return NextResponse.json({ error: "INGEST_SECRET_TOKEN not configured" }, { status: 500 })
  }

  let scanned = 0
  let totalMoments = 0
  try {
    const scan = await callScan(wallet)
    scanned = pickNumber(scan.scanned, scan.total)
    totalMoments = pickNumber(scan.total, scan.scanned)
  } catch (err) {
    return NextResponse.json(
      { error: "scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    )
  }

  let firstChunk: EnrichResponse
  try {
    firstChunk = await callEnrich(wallet, 0)
  } catch (err) {
    return NextResponse.json(
      { ok: true, scanned, totalMoments, enrichedSoFar: 0, done: false, enrichError: err instanceof Error ? err.message : String(err) },
      { status: 200 }
    )
  }

  const enrichedSoFar = pickNumber(firstChunk.totalEnriched, firstChunk.enriched)
  const total = pickNumber(firstChunk.total, totalMoments)
  const done = firstChunk.done === true

  if (!done) {
    // The enricher returns `nextStart` (the cursor for the next page, null
    // when done), NOT `next`/`totalEnriched`. Reading the wrong field made
    // the cursor fall back to enrichedSoFar (a count, not an offset) and
    // truncate any wallet >100 moments. Prefer nextStart; keep the old
    // fields as defensive fallbacks.
    const startNext = pickNumber(firstChunk.nextStart, firstChunk.next) || enrichedSoFar || 100
    after(async () => {
      let cursor = startNext
      let safety = 0
      while (safety < 50) {
        safety += 1
        try {
          const chunk = await callEnrich(wallet, cursor)
          if (chunk.done === true) {
            console.log(`[ufc-wallet-scan] enrich complete for ${wallet} after ${safety} chunks`)
            return
          }
          const next = pickNumber(chunk.nextStart, chunk.next)
          if (!next || next <= cursor) {
            console.warn(`[ufc-wallet-scan] enrich stalled at cursor=${cursor}, stopping`)
            return
          }
          cursor = next
        } catch (err) {
          console.error(`[ufc-wallet-scan] background enrich failed:`, err instanceof Error ? err.message : String(err))
          return
        }
      }
    })
  }

  return NextResponse.json({
    ok: true,
    scanned,
    enrichedSoFar,
    totalMoments: total || totalMoments,
    done,
  })
}
