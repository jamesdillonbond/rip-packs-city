import { NextRequest, NextResponse, after } from "next/server"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? ""

  if (!TOKEN || token !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const origin = new URL(req.url).origin

  // Kick off the chain in an after() hook so the HTTP response can return
  // within cron-job.org's 30s timeout. ingest -> sales-indexer -> fmv-recalc ->
  // listing-cache each fire the next step via after() as well, so no single
  // function has to wait for the whole pipeline.
  after(async () => {
    const start = Date.now()
    try {
      const res = await fetch(`${origin}/api/ingest?chain=true`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(55000),
      })
      console.log(
        `[pipeline-trigger] ingest kick status=${res.status} elapsed=${Date.now() - start}ms`
      )
    } catch (err) {
      console.error(
        "[pipeline-trigger] ingest kick failed:",
        err instanceof Error ? err.message : String(err)
      )
    }
  })

  return NextResponse.json({
    ok: true,
    message: "Pipeline triggered",
    triggeredAt: new Date().toISOString(),
  })
}
