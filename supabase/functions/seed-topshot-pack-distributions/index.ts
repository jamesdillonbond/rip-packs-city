// seed-topshot-pack-distributions — RETIRED 2026-11-19 (#218). Answers 410 Gone, does no work.
//
// Why: it upserted Top Shot pack_distributions from Dapper Studio GraphQL (searchPackNftAggregation), which
// has answered HTTP 530 since 2026-11-17 and whose pack index froze 2026-10-29. Every run since failed and
// wrote nothing (pipeline 'seed-topshot-pack-distributions'). Discovery is covered without it: the Atlas pack
// book lane (DistributionService, 20261108213316) seeds pack_distributions — dist 8944 (the newest Top Shot
// drop, 11-18) was present while this function was failing.
// Caller: an external cron-job.org entry (every 4 h at :13; not pg_cron, Vercel or GitHub Actions). It now gets
// an explicit 410 naming this file instead of a Studio 530 — remove that entry in the cron-job.org console.
//
// The last deployed source is archived at supabase/retired-functions/seed-topshot-pack-distributions/index.ts.txt
// (its header is the revival recipe).

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message: "seed-topshot-pack-distributions was retired on 2026-11-19 (#218: Studio GraphQL HTTP 530). See supabase/retired-functions/seed-topshot-pack-distributions/.",
      retired_at: "2026-11-19",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
)
