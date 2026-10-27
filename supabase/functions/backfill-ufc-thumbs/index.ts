// backfill-ufc-thumbs — RETIRED 2026-10-26 (register R137). Answers 410 Gone, does no work.
//
// Why: the deployed function had NO committed source and ran with verify_jwt=false; it skipped auth entirely when INGEST_SECRET_TOKEN was unset and wrote editions.thumbnail_url for a caller-chosen wallet.
// Callers on 2026-10-26: none — 0 pg_cron jobs, 0 repo/Vercel/GHA references, 0 invocations in 24 h of
// function_edge_logs (positive control: flowty-proxy 3,095 and 29 other functions in the same query; the
// register's 10-25 census read 0 over 7 days). A caller this census could not see (a cron-job.org entry)
// now gets an explicit 410 naming this file rather than silently running; watch function_edge_logs for 410s.
//
// The deployed source is archived, credentials redacted, at
// supabase/retired-functions/backfill-ufc-thumbs/index.ts.txt — that file's header is the revival recipe.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message: "backfill-ufc-thumbs was retired on 2026-10-26 (register R137). See supabase/retired-functions/backfill-ufc-thumbs/.",
      retired_at: "2026-10-26",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
)
