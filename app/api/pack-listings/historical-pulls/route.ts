import { NextRequest, NextResponse } from "next/server"

// GET /api/pack-listings/historical-pulls?title=<pack title>
//
// 🚨 WITHDRAWN 2026-09-09. This endpoint answered with a `total` and a
// `tierBreakdown` that it could not compute, and it is now explicit about that
// instead. Nothing renders these numbers: a full-repo grep on the same day found
// ZERO callers — the only references were this file and its own test — and the
// sibling `/api/pack-listings` (which IS called, by PackPageClient) is unrelated.
//
// ── WHAT IT USED TO DO, AND THE THREE DEFECTS ──────────────────────────────
// It read `moment_acquisitions` (Top Shot, acquisition_method = 'pack_pull')
// with `.limit(20000)`, batched `wallet_moments_cache` for tier + set_name, and
// counted the rows whose set_name loosely token-matched `?title`.
//
//  1. ⚠ THE NUMBER WAS A SAMPLE PUBLISHED AS A COUNT. Measured 2026-09-09 the
//     predicate matches 838,392 rows. PostgREST caps reads at 1,000 and CLAMPS a
//     larger explicit bound, so `.limit(20000)` returned 1,000 — 0.12% of the
//     population — and the read carried no `.order()`, so WHICH 1,000 was
//     whatever physical order the scan produced. `total` was then reported as a
//     historical pull count.
//  2. ⚠ A FAILED READ RENDERED AS A MEASURED ZERO. `if (error || !pulls) return
//     { total: 0, tierBreakdown: {} }` — our own outage published as "this pack
//     has no recorded pulls", the repo's most productive defect class. A test
//     PINNED that behaviour; it is inverted rather than deleted, per CLAUDE.md.
//  3. ⛔ THE JOIN IT NEEDED DOES NOT EXIST IN THE DATA. `moment_acquisitions`
//     carries `pack_dist_id`, which would tie a pull to a pack — and it is NULL
//     on all 838,392 of those rows (measured 2026-09-09, `count(pack_dist_id)`
//     = 0). That is why the route reached for a loose token match on set_name in
//     the first place; its own header called it a "Workaround"/"Heuristic".
//     ⚠ And even a complete scan would not answer the question asked:
//     `wallet_moments_cache` holds only the wallets we have backfilled, so the
//     honest label for any total it produces is "pulls among moments we happen
//     to have cached", not "historical pulls".
//
// ── WHY 501 AND NOT A DELETION ─────────────────────────────────────────────
// Deleting a route is a product call and this one has no urgency behind it — the
// endpoint is unreachable from the UI and behind the proxy's signed-in gate. A
// 501 keeps the diagnosis where the next reader meets it, costs one file, and is
// reversible in one commit. ⛔ Do NOT "restore" the old body: it cannot be made
// correct without a pack_dist_id backfill (defect 3), and re-adding a paged read
// over 838k rows in a request path is not the fix either.
//
// EXIT: if pack-level pull history is wanted, the work is (a) populate
// `moment_acquisitions.pack_dist_id` from the pack-opens ingest, then (b) answer
// this from an aggregate keyed on dist_id — not from a sampled table scan.

export async function GET(req: NextRequest) {
  const title = req.nextUrl.searchParams.get("title")
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 })

  // ⚠ No number is returned, deliberately. The three defects above mean every
  // shape this route could answer with — a count, a breakdown, even a zero — is
  // a claim the data cannot support. An honest 501 is the only response that is
  // not a fabrication.
  return NextResponse.json(
    {
      error:
        "Historical pull counts are unavailable: pack pulls are not linked to a pack distribution, so this cannot be computed.",
      code: "unavailable",
      retryable: false,
    },
    { status: 501 },
  )
}
