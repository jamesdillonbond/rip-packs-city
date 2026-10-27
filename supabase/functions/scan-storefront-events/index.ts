// scan-storefront-events — RETIRED 2026-10-26 (register R137). Answers 410 Gone, does no work.
//
// Why: the deployed function had NO committed source and ran with verify_jwt=false; its gate compared a caller's Bearer against INGEST_SECRET_TOKEN and did NOT fail closed on an unset secret (`Bearer undefined` matched).
// Callers on 2026-10-26: none — 0 pg_cron jobs, 0 repo/Vercel/GHA references, 0 invocations in 24 h of
// function_edge_logs (positive control: flowty-proxy 3,095 and 29 other functions in the same query; the
// register's 10-25 census read 0 over 7 days). A caller this census could not see (a cron-job.org entry)
// now gets an explicit 410 naming this file rather than silently running; watch function_edge_logs for 410s.
//
// The deployed source is archived, credentials redacted, at
// supabase/retired-functions/scan-storefront-events/index.ts.txt — that file's header is the revival recipe.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message: "scan-storefront-events was retired on 2026-10-26 (register R137). See supabase/retired-functions/scan-storefront-events/.",
      retired_at: "2026-10-26",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
)
