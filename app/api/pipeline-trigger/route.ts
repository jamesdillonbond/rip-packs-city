import { NextRequest, NextResponse } from "next/server"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

export async function GET(req: NextRequest) {
  const start = Date.now()
  const token = req.nextUrl.searchParams.get("token") ?? ""

  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const origin = new URL(req.url).origin

  const steps = [
    { name: "ingest", path: "/api/ingest", method: "POST" },
    { name: "sales-indexer", path: "/api/sales-indexer", method: "POST" },
    { name: "fmv-recalc", path: "/api/fmv-recalc", method: "POST" },
    { name: "listing-cache", path: "/api/listing-cache", method: "POST" },
  ]

  const results: Record<string, any> = {}
  let allSuccess = true

  for (const step of steps) {
    const stepStart = Date.now()
    try {
      const res = await fetch(`${origin}${step.path}`, {
        method: step.method,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(55000),
      })
      const body = await res.json().catch(() => null)
      results[step.name] = {
        status: res.status,
        ok: res.ok,
        data: body,
        elapsed: Date.now() - stepStart,
      }
      if (!res.ok) allSuccess = false
    } catch (err) {
      allSuccess = false
      results[step.name] = {
        status: 0,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsed: Date.now() - stepStart,
      }
    }
  }

  return NextResponse.json({
    success: allSuccess,
    steps: results,
    elapsed: Date.now() - start,
  })
}
