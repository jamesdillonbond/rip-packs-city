// app/api/ready/route.ts
//
// Readiness signal. Reads the per-collection sales slice that the two
// thin-volume consumers below actually use, and nothing else.
//
// Consumers:
//   - /[collection]/market    → thin-volume notice (sales_24h < 10)
//   - /[collection]/analytics → same
//   - Dashboards / readiness probes (these read the STATUS CODE, not the body)
//
// ── WHY THIS IS NOT `health_check()` ANY MORE (deep-audit R44) ──────────────
//
// This route 500'd from 2026-08-15 to 2026-08-23. The proximate cause was that
// `anon` lost EXECUTE on `health_check()`, and the obvious repair — put the
// grant back — is INVERTED. That revoke closed a real anon data leak:
// `health_check()` is SECURITY DEFINER and returns `users` (auth_users,
// active_7d, user_profiles, saved_wallets, active_allowed), `telemetry`
// (total_events, distinct_wallets, distinct_features), `insider_signals` and
// `db_size_mb`; this route spread the WHOLE payload (`{ ...data, … }`) and is
// anon-reachable via PUBLIC_READ_APIS. Until 2026-08-15 an unauthenticated GET
// published every one of those numbers to anyone on the internet.
//
// ⚠ AND THE GRANT WAS NEVER THE WHOLE STORY. Restoring it would not have made
// this route work: `health_check()` returns `collections` as a
// `json_object_agg` KEYED BY SLUG, and this file called `.map()` on it — a
// TypeError on an object, caught below, 500. There is no `fmv_pipeline`,
// `data_integrity`, `sales_pipeline` or `listing_cache` key in the deployed
// function either. The route was written against a shape the DB does not
// return, and `__tests__/api-ready.test.ts` stayed green the whole time because
// it MOCKED that invented payload. Nothing in CI compared the mock to the live
// function; a payload-shape test can only ever pin the fixture's own beliefs.
//
// ── WHAT WAS DROPPED, AND WHY IT IS NOT NULLED ─────────────────────────────
// `fmv_coverage_pct`, `fmv_staleness_minutes`, `overall_staleness_minutes`,
// `editions`, `total_sales`, `listing_count`, `listings_*` and the
// `status: "degraded"` / 503 branch are GONE, not set to 0 or null. They were
// never really being measured (see above), no caller in the repo reads any of
// them, and re-emitting them as zeros is precisely the fabricated-number shape.
// A field that is not measured should be absent, not present and wrong.
// `status` is now honest and binary: the read succeeded, or it did not.

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { safeApiError, errorLogDetail } from "@/lib/api-error";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
) as any;

export const dynamic = "force-dynamic";
export const maxDuration = 10;

// DB slug -> frontend slug used everywhere else in the app.
const DB_TO_FRONTEND: Record<string, string> = {
  "nba_top_shot": "nba-top-shot",
  "nfl_all_day": "nfl-all-day",
  "laliga_golazos": "laliga-golazos",
  "disney_pinnacle": "disney-pinnacle",
  "ufc_strike": "ufc",
  "ufc": "ufc",
};

function failed(err: unknown, where: string) {
  console.error(`[api/ready] ${where}: ${errorLogDetail(err)}`);
  return NextResponse.json(
    // Shape is preserved (`status: "error"` is this probe's contract with the
    // monitoring consumers listed above), but the driver text is not published:
    // /api/ready is anon-reachable via PUBLIC_READ_APIS, so `error.message` put
    // Postgres's own wording in front of anyone who asked. Detail goes to the log.
    { status: "error", ...safeApiError(err, "Readiness check failed.") },
    { status: 500 }
  );
}

export async function GET() {
  try {
    const { data, error } = await supabase.rpc("readiness_collection_stats");

    if (error) return failed(error, "readiness_collection_stats failed");

    // ⚠ A non-array payload is a BROKEN CONTRACT, not an empty market, and the
    // difference is the whole of R44: the previous version reached `.map()` on
    // whatever came back and let a shape change surface as a 500 with no clue
    // in it. `[]` from the RPC is a legitimate "no active collections"; an
    // object or a null is the function having changed underneath us, and that
    // must be loud rather than rendered as "every collection is thin".
    if (!Array.isArray(data)) {
      return failed(
        new Error(`readiness_collection_stats returned ${data === null ? "null" : typeof data}, expected an array`),
        "unexpected RPC shape"
      );
    }

    const perCollection = data.map((c: any) => ({
      slug: DB_TO_FRONTEND[c?.slug] ?? c?.slug ?? null,
      db_slug: c?.slug ?? null,
      name: c?.name ?? null,
      // Never coerce a missing count to 0 — a fabricated zero here renders as
      // "THIN-VOLUME ECOSYSTEM" on a collection that may be trading heavily.
      sales_24h: typeof c?.sales_24h === "number" ? c.sales_24h : null,
      last_sale_at: c?.last_sale_at ?? null,
    }));

    return NextResponse.json(
      {
        status: "ok",
        generated_at: new Date().toISOString(),
        per_collection: perCollection,
      },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  } catch (err: any) {
    return failed(err, "exception");
  }
}
