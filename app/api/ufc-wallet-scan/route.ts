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
  [key: string]: unknown
}

type ScanResponse = {
  scanned?: number
  total?: number
  [key: string]: unknown
}

async function callScan(wallet: string): Promise<ScanResponse> {
  const url = `${SUPABASE_FN_BASE}/scan-ufc-wallet?wallet=${encodeURIComponent(wallet)}&token=${TOKEN}`
  const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`scan-ufc-wallet HTTP ${res.status}`)
  return (await res.json()) as ScanResponse
}

async function callEnrich(wallet: string, start: number): Promise<EnrichResponse> {
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
    const startNext = pickNumber(firstChunk.next) || enrichedSoFar || 100
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
          const next = pickNumber(chunk.next, chunk.totalEnriched)
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
