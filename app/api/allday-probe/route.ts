import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// Temporary health-check endpoint for NFL All Day deployment verification.
// Tests GraphQL connectivity, Supabase collection row, Cadence script, and sniper feed.
// Delete after confirming deployment.

const EXPECTED_TOKEN = "rippackscity2026"

type ProbeResult = { name: string; ok: boolean; detail?: string; durationMs: number }

async function runProbe(name: string, fn: () => Promise<string>): Promise<ProbeResult> {
  const start = Date.now()
  try {
    const detail = await fn()
    return { name, ok: true, detail, durationMs: Date.now() - start }
  } catch (err) {
    return { name, ok: false, detail: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }
  }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const token = url.searchParams.get("token")
  if (token !== EXPECTED_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const probeParam = url.searchParams.get("probe") ?? "all"
  const probes: Promise<ProbeResult>[] = []

  // 1. GraphQL connectivity — simple introspection-like query
  if (probeParam === "all" || probeParam === "graphql") {
    probes.push(runProbe("allday-graphql", async () => {
      const res = await fetch("https://public-api.nflallday.com/graphql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ __typename }` }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      return `status=${res.status} typename=${json?.data?.__typename ?? "null"}`
    }))
  }

  // 2. Supabase collection row exists
  if (probeParam === "all" || probeParam === "supabase") {
    probes.push(runProbe("supabase-collection", async () => {
      const { data, error } = await supabaseAdmin
        .from("collections")
        .select("id, slug")
        .eq("slug", "nfl_all_day")
        .single()
      if (error) throw new Error(error.message)
      if (!data) throw new Error("No nfl_all_day row found")
      return `id=${data.id} slug=${data.slug}`
    }))
  }

  // 3. Supabase schema check — verify collection column exists on key tables
  if (probeParam === "all" || probeParam === "schema") {
    probes.push(runProbe("schema-collection-column", async () => {
      const tables = ["editions", "fmv_snapshots", "sales", "moments"]
      const results: string[] = []
      for (const table of tables) {
        const { data, error } = await supabaseAdmin
          .from(table)
          .select("collection_id")
          .limit(1)
        if (error) {
          results.push(`${table}: ERROR ${error.message}`)
        } else {
          results.push(`${table}: OK (${data?.length ?? 0} rows sampled)`)
        }
      }
      return results.join("; ")
    }))
  }

  // 4. Sniper feed responds
  if (probeParam === "all" || probeParam === "sniper") {
    probes.push(runProbe("allday-sniper-feed", async () => {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://rip-packs-city.vercel.app"
      const res = await fetch(`${baseUrl}/api/allday-sniper-feed?limit=5`, {
        signal: AbortSignal.timeout(10000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const dealCount = json?.deals?.length ?? 0
      return `status=${res.status} deals=${dealCount}`
    }))
  }

  // 5. Ingest endpoint responds (GET = dry run)
  if (probeParam === "all" || probeParam === "ingest") {
    probes.push(runProbe("allday-ingest-reachable", async () => {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://rip-packs-city.vercel.app"
      const res = await fetch(`${baseUrl}/api/allday-ingest`, {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      })
      const json = await res.json().catch(() => ({}))
      return `status=${res.status} ok=${json?.ok ?? "?"} sales=${json?.salesIngested ?? "?"}`
    }))
  }

  const results = await Promise.all(probes)
  const allOk = results.every(r => r.ok)

  return NextResponse.json({
    collection: "nfl_all_day",
    allOk,
    probes: results,
    timestamp: new Date().toISOString(),
  })
}
