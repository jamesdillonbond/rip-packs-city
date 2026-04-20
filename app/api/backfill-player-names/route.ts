import { NextRequest, NextResponse } from "next/server"

const EDGE_FN_URL = "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/backfill-player-names"

export async function POST(req: NextRequest) {
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    )
  }

  // Verify ingest token
  const auth = req.headers.get("authorization") ?? ""
  const token = auth.replace(/^Bearer\s+/i, "")
  if (!token || token !== ingestToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const res = await fetch(EDGE_FN_URL, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + ingestToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(55000),
    })

    const text = await res.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = { raw: text }
    }

    if (!res.ok) {
      console.log("[backfill-player-names] Edge Function returned " + res.status + ": " + text.slice(0, 500))
      return NextResponse.json({ error: "Edge Function returned " + res.status, detail: json }, { status: res.status })
    }

    console.log("[backfill-player-names] success:", JSON.stringify(json).slice(0, 500))
    return NextResponse.json(json)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log("[backfill-player-names] error:", msg)
    return NextResponse.json({ error: msg }, { status: 502 })
  }
}
