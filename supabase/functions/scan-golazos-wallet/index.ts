// scan-golazos-wallet — RETIRED 2026-10-14 (register R21). Answers 410 Gone, does no work.
//
// Why: the deployed v51 had NO committed source and was gated by a shared 16-char Bearer literal hardcoded in
// the function, with verify_jwt=false — so anyone holding that guessable value could run it with
// the service-role key. What it did: upserted wallet_moments_cache for ANY ?wallet= with onConflict wallet_address,moment_id (no collection_id, the #142 class) and a lower-cased address.
// Callers on 2026-10-14: none — 0 pg_cron jobs, 0 repo/Vercel/GHA references, 0 invocations in 24 h of
// function_edge_logs (positive control: the two active AllDay lanes read 45 and 320 in the same query).
// A caller this census could not see (a weekly cron-job.org entry) now gets an explicit 410 naming this
// file rather than silently running; watch function_edge_logs for 410s on this path.
//
// The deployed source is archived, credentials redacted, at
// supabase/retired-functions/scan-golazos-wallet/index.ts.txt — that file's header is the revival recipe.

Deno.serve(() =>
  new Response(
    JSON.stringify({
      error: "retired",
      message: "scan-golazos-wallet was retired on 2026-10-14 (register R21). See supabase/retired-functions/scan-golazos-wallet/.",
      retired_at: "2026-10-14",
    }),
    { status: 410, headers: { "Content-Type": "application/json" } },
  )
)
