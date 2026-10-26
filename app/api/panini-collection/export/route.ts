// app/api/panini-collection/export/route.ts
//
// Full-collection CSV for the Panini Collection tab (2026-10-26). The tab loads only the
// highest-FMV 500 (profile) / 200 (seen) cards, so its in-page CSV covers at most those; this
// pages EVERY card through panini_collection_export (keyset on sku, 1,000 a page) and returns
// one CSV with the same columns as the in-page export (lib/panini/collection-view.ts).
//
// ── HONESTY ────────────────────────────────────────────────────────────────
//   · ALL OR NOTHING: any failed page is a 503 — a partial file would read as the whole
//     collection (CLAUDE.md: a paged read that `break`s on error returns a partial list).
//   · A collection past MAX_CARDS is refused with a 413 that says so, never truncated.
//   · Source is stated in the filename (profile = the public profile as RPC last read it;
//     seen = the cards RPC has seen under the name), never mixed.
//   · An unpriced card has an empty FMV cell, never 0; no confidence column.
//   · A username RPC has nothing for is a 404 with copy that it is "not seen", never an empty file.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"
import { buildPaniniCollectionCsv } from "@/lib/panini/collection-view"
import { PANINI_EXPORT_MAX_CARDS, paniniExportRowsToCards, type PaniniExportPage } from "@/lib/panini/collection-export"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PAGE = 1000

export async function GET(req: NextRequest) {
  const raw = (req.nextUrl.searchParams.get("username") ?? "").trim()
  const username = raw ? normalizePaniniUsername(raw) : null
  if (!username) {
    return NextResponse.json(
      { error: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -).", code: "bad_request", retryable: false },
      { status: 400 },
    )
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const cards: ReturnType<typeof paniniExportRowsToCards> = []
    let source: "profile" | "seen" | null = null
    let after: string | null = null
    for (;;) {
      // Each page is bounded: a hung read becomes the 503 below, not a request that runs to maxDuration.
      const { data, error } = await boundedRead(db.rpc("panini_collection_export", { p_username: username, p_after_sku: after, p_limit: PAGE }), "panini-collection-export")
      if (error) return apiErrorResponse(error, "api/panini-collection/export", "This collection can't be exported right now.")
      const page = (Array.isArray(data) ? data[0] : data) as PaniniExportPage | null
      if (!page || !Array.isArray(page.rows) || (page.source !== "profile" && page.source !== "seen")) {
        return apiErrorResponse(new Error("panini_collection_export returned an unexpected shape"), "api/panini-collection/export", "This collection can't be exported right now.")
      }
      // The source is decided per call; a walk landing mid-export would switch it — refuse a mixed file.
      if (source && page.source !== source) {
        return apiErrorResponse(new Error("panini export source changed mid-export"), "api/panini-collection/export", "This collection changed while it was being exported — try again.")
      }
      source = page.source
      cards.push(...paniniExportRowsToCards(page.rows))
      if (cards.length > PANINI_EXPORT_MAX_CARDS) {
        return NextResponse.json(
          { error: `This collection is larger than ${PANINI_EXPORT_MAX_CARDS.toLocaleString("en-US")} cards — too large to export in one file.`, code: "too_large", retryable: false },
          { status: 413 },
        )
      }
      if (page.rows.length < PAGE) break
      after = String(page.rows[page.rows.length - 1].sku)
    }
    if (cards.length === 0) {
      return NextResponse.json(
        { error: `RPC hasn't seen a card under ${username} — that does not mean the collector holds nothing.`, code: "not_seen", retryable: false },
        { status: 404 },
      )
    }
    const csv = buildPaniniCollectionCsv(cards)
    const safe = username.replace(/[^A-Za-z0-9_-]/g, "") || "collection"
    const which = source === "profile" ? "profile" : "seen-by-rpc"
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="panini-${safe}-${which}-all.csv"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (err) {
    return apiErrorResponse(err, "api/panini-collection/export", "This collection can't be exported right now.")
  }
}
