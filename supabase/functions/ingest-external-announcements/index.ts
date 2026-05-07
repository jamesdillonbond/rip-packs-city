// RETIRED 2026-05-07: Reddit/RSS path abandoned, see /api/admin/announcements for current ingest.
// ingest-external-announcements
//
// Polls the public surfaces (RSS feeds, Twitter mirrors via Nitter,
// community trackers) for Top Shot / Pinnacle / AllDay announcements
// and writes new entries to external_announcements. Each source has a
// list of fallback URLs; the function tries them in order until one
// returns parseable XML. Failures per-source are non-fatal — they're
// logged and the function continues to the next source.
//
// Deduplication: external_announcements has UNIQUE (source, external_id).
// onConflict do nothing keeps the function safe to fire repeatedly.
//
// Schedule: cron-job.org every 30 minutes via /api/cron/ingest-announcements
// (or directly via this function — same Bearer auth either way).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 3
const PIPELINE = "ingest-external-announcements"

// Cap the per-attempt body excerpt we surface into pipeline_runs.extra so a
// run-of-the-mill 403/429/Cloudflare-challenge body doesn't blow up the JSON
// payload. 500 chars is enough to identify the failure mode (Reddit's text
// 429s, Cloudflare interstitial markers, DNS/timeout exception messages).
const BODY_EXCERPT_MAX = 500

interface SourceConfig {
  source: "topshot" | "pinnacle" | "allday"
  channel: string // human-readable label written to source_channel
  // Fallback URLs tried in order; first one returning parseable XML wins.
  feeds: string[]
}

// Pivot 2026-05-07: every Nitter mirror in the v1 registry is dead.
// nitter.net 404s, privacydev returns DNS errors, poast/space 403, and the
// last two answering 200 (tiekoetter, cz) gate behind Anubis / Cloudflare
// challenge pages — they return HTML, not RSS, so the function read
// `all_feeds_failed` for every source on every run.
//
// Reddit's per-subreddit Atom feeds at /r/<sub>/.rss are public, do not
// require auth, and respond as `application/atom+xml` for any browser-style
// User-Agent. Coverage is complete for our three target communities and the
// existing parseFeed() handles Atom entries.
const SOURCES: SourceConfig[] = [
  {
    source: "topshot",
    channel: "reddit:r/nbatopshot",
    feeds: [
      "https://www.reddit.com/r/nbatopshot/.rss",
      "https://old.reddit.com/r/nbatopshot/.rss",
    ],
  },
  {
    source: "pinnacle",
    channel: "reddit:r/DisneyPinnacle",
    feeds: [
      "https://www.reddit.com/r/DisneyPinnacle/.rss",
      "https://old.reddit.com/r/DisneyPinnacle/.rss",
    ],
  },
  {
    source: "allday",
    channel: "reddit:r/NFLAllDay",
    feeds: [
      "https://www.reddit.com/r/NFLAllDay/.rss",
      "https://old.reddit.com/r/NFLAllDay/.rss",
    ],
  },
]

// ── Minimal RSS / Atom parser ──────────────────────────────────────────
// Handles the common RSS 2.0 + Atom 1.0 elements without external deps.
// Tolerant of CDATA, HTML entities, and partial element availability —
// rows with missing fields fall back to NULL on the schema side.

interface ParsedEntry {
  external_id: string | null
  title: string | null
  content: string
  posted_at: string // ISO 8601
  source_url: string | null
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

function extractTag(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i")
  const m = block.match(re)
  if (!m) return null
  return decodeEntities(m[1].trim()) || null
}

function parseDate(s: string | null): string | null {
  if (!s) return null
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return null
  return new Date(ms).toISOString()
}

function parseFeed(xml: string): ParsedEntry[] {
  const out: ParsedEntry[] = []

  // RSS <item> blocks
  const itemRe = /<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    const title = extractTag(block, "title")
    const pubDate = extractTag(block, "pubDate")
    const link = extractTag(block, "link")
    const guid = extractTag(block, "guid")
    const description = extractTag(block, "description") ?? extractTag(block, "content:encoded") ?? title ?? ""
    const posted = parseDate(pubDate)
    if (!posted) continue
    const externalId = guid ?? link ?? `${posted}|${title ?? ""}`.slice(0, 200)
    out.push({
      external_id: externalId,
      title,
      content: description,
      posted_at: posted,
      source_url: link,
    })
  }

  if (out.length === 0) {
    // Atom <entry> fallback
    const entryRe = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi
    while ((m = entryRe.exec(xml)) !== null) {
      const block = m[1]
      const title = extractTag(block, "title")
      const pubDate = extractTag(block, "published") ?? extractTag(block, "updated")
      const linkMatch = block.match(/<link[^>]*href="([^"]+)"/i)
      const link = linkMatch ? linkMatch[1] : null
      const id = extractTag(block, "id")
      const summary = extractTag(block, "summary") ?? extractTag(block, "content") ?? title ?? ""
      const posted = parseDate(pubDate)
      if (!posted) continue
      const externalId = id ?? link ?? `${posted}|${title ?? ""}`.slice(0, 200)
      out.push({
        external_id: externalId,
        title,
        content: summary,
        posted_at: posted,
        source_url: link,
      })
    }
  }

  return out
}

interface FetchAttempt {
  url: string
  status: number
  error?: string
  error_kind?: "http_error" | "empty_body" | "exception"
  exception_name?: string
  body_excerpt?: string
  content_type?: string | null
  elapsed_ms: number
}

async function fetchOneFeed(url: string): Promise<{ xml: string | null; attempt: FetchAttempt }> {
  const started = Date.now()
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "RipPacksCity-AnnouncementIngester/1.0 (+https://www.rippackscity.com)",
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(12_000),
    })
    const contentType = res.headers.get("content-type")
    if (!res.ok) {
      // Read the error body so we can tell 403-from-Cloudflare apart from
      // 429-from-Reddit-rate-limit apart from a generic upstream HTML
      // interstitial. Tolerate a body read failure (some upstreams hang up).
      let bodyExcerpt = ""
      try {
        const errBody = await res.text()
        bodyExcerpt = (errBody ?? "").slice(0, BODY_EXCERPT_MAX)
      } catch (_e) {
        bodyExcerpt = "<body read failed>"
      }
      return {
        xml: null,
        attempt: {
          url,
          status: res.status,
          error: `HTTP ${res.status}`,
          error_kind: "http_error",
          body_excerpt: bodyExcerpt,
          content_type: contentType,
          elapsed_ms: Date.now() - started,
        },
      }
    }
    const body = await res.text()
    if (!body || body.length < 64) {
      return {
        xml: null,
        attempt: {
          url,
          status: res.status,
          error: "empty_or_tiny_body",
          error_kind: "empty_body",
          body_excerpt: (body ?? "").slice(0, BODY_EXCERPT_MAX),
          content_type: contentType,
          elapsed_ms: Date.now() - started,
        },
      }
    }
    return {
      xml: body,
      attempt: {
        url,
        status: res.status,
        content_type: contentType,
        elapsed_ms: Date.now() - started,
      },
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "Unknown"
    const message = err instanceof Error ? err.message : String(err)
    return {
      xml: null,
      attempt: {
        url,
        status: 0,
        error: message,
        error_kind: "exception",
        exception_name: name,
        elapsed_ms: Date.now() - started,
      },
    }
  }
}

interface SourceResult {
  source: string
  url_used: string | null
  attempts: FetchAttempt[]
  parsed: number
  inserted: number
  skipped_dupe: number
  errors: string[]
}

async function ingestSource(cfg: SourceConfig): Promise<SourceResult> {
  const result: SourceResult = {
    source: cfg.source,
    url_used: null,
    attempts: [],
    parsed: 0,
    inserted: 0,
    skipped_dupe: 0,
    errors: [],
  }

  let xml: string | null = null
  for (const url of cfg.feeds) {
    const r = await fetchOneFeed(url)
    result.attempts.push(r.attempt)
    if (r.xml) {
      xml = r.xml
      result.url_used = url
      break
    }
  }
  if (!xml) {
    result.errors.push("all_feeds_failed")
    return result
  }

  const entries = parseFeed(xml)
  result.parsed = entries.length

  if (entries.length === 0) {
    result.errors.push("no_entries_parsed")
    return result
  }

  // Insert with onConflict do nothing on (source, external_id).
  for (const e of entries) {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabase as any)
      .from("external_announcements")
      .insert({
        source: cfg.source,
        source_channel: cfg.channel,
        source_url: e.source_url,
        posted_at: e.posted_at,
        title: e.title,
        content: e.content,
        external_id: e.external_id,
      })
      .select("id")
    if (error) {
      // 23505 = unique-violation = expected dedup hit. Anything else is a
      // real write error worth logging.
      if (error.code === "23505" || /duplicate key/i.test(error.message)) {
        result.skipped_dupe++
      } else {
        result.errors.push(`insert: ${error.message}`)
      }
    } else if (data && data.length > 0) {
      result.inserted++
    }
  }

  return result
}

async function logRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: null,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[${PIPELINE}] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWork(startedAtIso: string, started: number) {
  let totalParsed = 0
  let totalInserted = 0
  let totalDupe = 0
  const sourceResults: SourceResult[] = []

  for (const cfg of SOURCES) {
    const r = await ingestSource(cfg)
    totalParsed += r.parsed
    totalInserted += r.inserted
    totalDupe += r.skipped_dupe
    sourceResults.push(r)
  }

  const allFailed = sourceResults.every(r => r.parsed === 0)
  await logRun({
    startedAt: startedAtIso,
    rowsFound: totalParsed,
    rowsWritten: totalInserted,
    rowsSkipped: totalDupe,
    ok: !allFailed,
    error: allFailed ? "all_sources_failed_to_parse" : null,
    extra: {
      function_version: FUNCTION_VERSION,
      total_parsed: totalParsed,
      total_inserted: totalInserted,
      total_dupe: totalDupe,
      sources: sourceResults.map(r => ({
        source: r.source,
        url_used: r.url_used,
        parsed: r.parsed,
        inserted: r.inserted,
        skipped_dupe: r.skipped_dupe,
        errors: r.errors.slice(0, 3),
        // Full per-feed attempt detail (status, error_kind, exception_name,
        // body_excerpt, content_type, elapsed_ms) so a one-shot run reveals
        // whether Reddit's hitting us with 403 / 429 / Cloudflare interstitial
        // / DNS / timeout from Supabase egress. Query via:
        //   SELECT extra->'sources' FROM pipeline_runs
        //   WHERE pipeline = 'ingest-external-announcements'
        //   ORDER BY started_at DESC LIMIT 1;
        attempts: r.attempts,
      })),
      elapsed_ms: Date.now() - started,
    },
  })
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch(e => console.log(`[${PIPELINE}] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      function_version: FUNCTION_VERSION,
      sources_configured: SOURCES.map(s => s.source),
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
