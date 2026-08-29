// admin-badge-backfill-bridge — RETIRED 2026-07-16. The backfill is now
// durable via the Vercel cron (15 3,9,15,21) on backfill-badges-from-sets;
// no manual trigger needed. Permanently stubbed.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ error: "gone", retired: "2026-07-16" }), { status: 410, headers: { "content-type": "application/json" } }));
