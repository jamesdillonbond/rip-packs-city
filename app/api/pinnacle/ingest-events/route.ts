import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { ingestPinnacleSalesEvents } from "@/lib/pinnacle/flow-events"

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const fromBlock = body.fromBlock as number | undefined

    const result = await ingestPinnacleSalesEvents(supabaseAdmin, fromBlock)

    return NextResponse.json({
      status: "ok",
      sales_ingested: result.sales_ingested,
      new_cursor: result.new_cursor,
      errors: result.errors,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error"
    return NextResponse.json(
      { status: "error", error: message },
      { status: 500 }
    )
  }
}
