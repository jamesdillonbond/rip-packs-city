import { NextRequest, NextResponse } from "next/server"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

export async function GET(req: NextRequest) {
  const start = Date.now()
  const token = req.nextUrl.searchParams.get("token") ?? ""

  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const origin = new URL(req.url).origin

  // Kick off the chain — only call ingest. Each step fires the next step
  // as a fire-and-forget request so no single Vercel function has to wait
  // for the whole pipeline to finish.
  try {
    const res = await fetch(`${origin}/api/ingest?chain=true`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(55000),
    })
    const body = await res.json().catch(() => null)
    return NextResponse.json({
      success: res.ok,
      status: res.status,
      data: body,
      note: "pipeline chain started — sales-indexer, fmv-recalc, listing-cache run asynchronously downstream",
      elapsed: Date.now() - start,
    })
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        elapsed: Date.now() - start,
      },
      { status: 502 }
    )
  }
}
