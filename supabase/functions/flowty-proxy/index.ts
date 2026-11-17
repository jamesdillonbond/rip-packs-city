// flowty-proxy — RETIRED 2026-10-30. Answers 410 Gone, does no work.
//
// It forwarded Flowty collection-page requests for the three Flowty listing-cache lanes (Top Shot, All Day,
// Golazos). The Flowty API went dark 2026-10-27 ~9:20 PM PT and stayed dark more than 24 h after Dapper's
// markets reopened (All Day's first sale 10-28 11:12 PM PT), Trevor's gate for the teardown. The lanes and
// their routes were deleted in the same push (docs/operations/flowty-retirement-runbook.md §3).
//
// The source it ran is archived at supabase/retired-functions/flowty-proxy/index.ts.txt — its header is the
// revival recipe.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message: "flowty-proxy was retired on 2026-10-30 (Flowty API dark). See supabase/retired-functions/flowty-proxy/.",
      retired_at: "2026-10-30",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
)
