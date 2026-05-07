// app/api/admin/announcements/route.ts
// POST /api/admin/announcements
//
// Webhook ingest for community announcements (Discord, Make.com, etc).
// Replaces the now-retired Reddit/RSS edge-function path.
//
// Auth: bearer token via `Authorization: Bearer <token>` OR `?token=<token>`,
// checked against ANNOUNCEMENTS_INGEST_TOKEN. Deliberately separate from
// RPC_ADMIN_TOKEN so rotating the bridge credential does not invalidate
// the dashboard admin session.

import { createHash, randomUUID } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

const ALLOWED_SOURCES = ["topshot", "pinnacle", "allday", "golazos", "ufc"] as const
type AllowedSource = typeof ALLOWED_SOURCES[number]

function verifyBearer(req: NextRequest): boolean {
  const expected = process.env.ANNOUNCEMENTS_INGEST_TOKEN
  if (!expected) return false
  const header = req.headers.get("authorization") ?? ""
  if (header === `Bearer ${expected}`) return true
  return req.nextUrl.searchParams.get("token") === expected
}

function isValidUrl(s: string): boolean {
  try {
    new URL(s)
    return true
  } catch {
    return false
  }
}

const KNOWN_FIELDS = new Set([
  "source",
  "title",
  "content",
  "source_url",
  "source_channel",
  "posted_at",
  "external_id",
  "attachments",
])

export async function POST(req: NextRequest) {
  if (!verifyBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", field: "body" }, { status: 400 })
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Body must be a JSON object", field: "body" }, { status: 400 })
  }

  const source = body.source
  if (typeof source !== "string" || !ALLOWED_SOURCES.includes(source as AllowedSource)) {
    return NextResponse.json(
      { error: `source must be one of: ${ALLOWED_SOURCES.join(", ")}`, field: "source" },
      { status: 400 },
    )
  }

  const rawTitle = body.title
  if (typeof rawTitle !== "string") {
    return NextResponse.json({ error: "title is required (string)", field: "title" }, { status: 400 })
  }
  const title = rawTitle.trim()
  if (!title) {
    return NextResponse.json({ error: "title must not be empty after trim", field: "title" }, { status: 400 })
  }

  const content = typeof body.content === "string" ? body.content : ""

  let sourceUrl: string | null = null
  if (body.source_url !== undefined && body.source_url !== null) {
    if (typeof body.source_url !== "string" || !isValidUrl(body.source_url)) {
      return NextResponse.json({ error: "source_url must be a valid URL", field: "source_url" }, { status: 400 })
    }
    sourceUrl = body.source_url
  }

  const sourceChannel = typeof body.source_channel === "string" ? body.source_channel : null

  let postedAtIso: string
  if (body.posted_at !== undefined && body.posted_at !== null) {
    if (typeof body.posted_at !== "string") {
      return NextResponse.json({ error: "posted_at must be an ISO timestamp string", field: "posted_at" }, { status: 400 })
    }
    const ms = Date.parse(body.posted_at)
    if (!Number.isFinite(ms)) {
      return NextResponse.json({ error: "posted_at must be a parseable ISO timestamp", field: "posted_at" }, { status: 400 })
    }
    postedAtIso = new Date(ms).toISOString()
  } else {
    postedAtIso = new Date().toISOString()
  }

  let externalId: string
  if (body.external_id !== undefined && body.external_id !== null) {
    if (typeof body.external_id !== "string" || body.external_id.trim() === "") {
      return NextResponse.json({ error: "external_id must be a non-empty string", field: "external_id" }, { status: 400 })
    }
    externalId = body.external_id
  } else {
    externalId = createHash("sha256")
      .update(`${source}|${title}|${postedAtIso}`)
      .digest("hex")
      .slice(0, 32)
  }

  const attachments = body.attachments !== undefined ? body.attachments : null

  const rawPayload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (!KNOWN_FIELDS.has(k)) rawPayload[k] = v
  }

  // Service-role insert; ON CONFLICT (source, external_id) DO NOTHING via the
  // existing external_announcements_dedup unique index.
  const { data, error } = await supabaseAdmin
    .from("external_announcements")
    .upsert(
      {
        source,
        title,
        content,
        source_url: sourceUrl,
        source_channel: sourceChannel,
        posted_at: postedAtIso,
        external_id: externalId,
        attachments,
        raw_payload: Object.keys(rawPayload).length > 0 ? rawPayload : null,
      },
      { onConflict: "source,external_id", ignoreDuplicates: true },
    )
    .select("id")

  if (error) {
    return NextResponse.json(
      { error: error.message, code: error.code, request_id: randomUUID() },
      { status: 500 },
    )
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ status: "skipped_duplicate", source, external_id: externalId })
  }

  return NextResponse.json({
    status: "inserted",
    id: data[0].id,
    source,
    external_id: externalId,
  })
}
